# Order Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Click an order in the dashboard feed to open a slide-in drawer showing its status history, notifications, charges, assigned vehicle, and a highlighted road route on the map.

**Architecture:** Add a `status_history` array appended at the store's single mutation point (`store.upsertOrder`), so both the simulator and real agents record transitions with no caller changes. Everything else is client-side in `public/dashboard.html`: a drawer rendered from the SSE snapshot that already streams whole orders, and a Mapbox Directions call (one per selection) for the highlighted route.

**Tech Stack:** TypeScript (ESM, `NodeNext`, strict), plain HTML/CSS/JS dashboard, Mapbox GL JS v3 + Directions API.

**Spec:** `docs/superpowers/specs/2026-07-08-order-detail-view-design.md`

## Global Constraints

- No test suite / linter exists: `npm run typecheck` is the only automated check; behavioral verification is manual/browser (spec §Testing).
- Never `console.log` in `src/**` (stdout is the MCP channel); `console.error` only. One-off verification scripts run via `node -e` are fine.
- ESM: relative imports in `src/**` must use the `.js` extension.
- All store-sourced strings rendered into `innerHTML` must pass through the existing `esc()` helper in `dashboard.html`.
- Work happens on branch `feat/order-detail-view` (already created; spec committed there).
- `.env` may set `REDIS_URL`; force in-memory for verification scripts by prefixing `REDIS_URL=` (empty) so live Redis state isn't polluted.

---

### Task 1: Status history in the store

**Files:**
- Modify: `src/types.ts` (Order interface, ~line 44)
- Modify: `src/store.ts` (`upsertOrder`, lines 40–74)

**Interfaces:**
- Produces: `Order.status_history?: { status: OrderStatus; at: string }[]` — appended by `upsertOrder` whenever the resolved status differs from the last history entry (or history is empty). Task 2 reads this field from SSE snapshots.

- [ ] **Step 1: Add the type**

In `src/types.ts`, add above the `Order` interface:

```ts
export interface StatusChange {
  status: OrderStatus;
  at: string;
}
```

and inside `Order`, after `eta?: string | null;`:

```ts
  status_history?: StatusChange[];
```

- [ ] **Step 2: Append history in `upsertOrder`**

In `src/store.ts`, replace the `const next: Order = { ... }` block (lines 60–67) with:

```ts
    const nextStatus: OrderStatus =
      status ?? (fields?.status as OrderStatus) ?? base.status;
    // Append a history entry on the first write and on every status change.
    // upsertOrder is the single mutation point, so the simulator and the real
    // agents (via state.write) both get recorded with no caller changes.
    const prevHistory = base.status_history ?? [];
    const status_history =
      prevHistory.length === 0 ||
      prevHistory[prevHistory.length - 1].status !== nextStatus
        ? [...prevHistory, { status: nextStatus, at: now() }]
        : prevHistory;

    const next: Order = {
      ...base,
      ...(fields ?? {}),
      order_id: id, // never let a patch rewrite identity
      status: nextStatus,
      status_history, // after the fields spread so a patch can't clobber it
      updated_at: now(),
      created_at: base.created_at,
    };
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0.

- [ ] **Step 4: Behavioral check against the built store**

Run (Bash, from repo root — empty `REDIS_URL` forces the in-memory backend):

```bash
REDIS_URL= node -e "
import('./dist/store.js').then(async ({ store }) => {
  await store.upsertOrder('t-hist', 'created', {});
  await store.upsertOrder('t-hist', undefined, { note: 'patch only' });
  await store.upsertOrder('t-hist', 'routed', {});
  await store.upsertOrder('t-hist', 'routed', {});
  const o = await store.getOrder('t-hist');
  console.log(o.status_history.map(h => h.status).join(','));
});
"
```

Expected output: `created,routed` — exactly two entries: the field-only patch and the repeat-status write must NOT append.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/store.ts
git commit -m "feat: record order status history at the store mutation point"
```

---

### Task 2: Slide-in drawer with unified event log

**Files:**
- Modify: `public/dashboard.html` (CSS block, `#map` markup, script)

**Interfaces:**
- Consumes: `Order.status_history` from Task 1 (synthesizes `[{ status, at: updated_at }]` when absent — legacy orders), plus existing `notifications[]` / `transactions[]` / `assigned_vehicle`.
- Produces: `selectedOrderId` (module-level `let`), `selectOrder(id)`, `closeDrawer()`, and calls `drawRouteIfNeeded(o)` / `clearRoute()` — Task 3 implements those two as real functions; in this task add them as no-op stubs so the file stays runnable:

```js
function drawRouteIfNeeded(o) {} // Task 3
function clearRoute() {}          // Task 3
```

- [ ] **Step 1: Add drawer CSS**

In the `<style>` block, after the `.empty` rule:

```css
  /* ── order detail drawer ── */
  .ticket { cursor: pointer; }
  .ticket:hover { background: var(--panel-2); }
  .ticket.sel { background: var(--panel-2); }
  .drawer {
    position: absolute; top: 0; right: 0; bottom: 0; width: 330px; z-index: 6;
    background: var(--panel); border-left: 1px solid var(--line);
    transform: translateX(105%); transition: transform .22s ease;
    display: flex; flex-direction: column;
    box-shadow: -12px 0 28px rgba(0,0,0,.45);
  }
  .drawer.open { transform: translateX(0); }
  .drawer-head {
    padding: 13px 16px; border-bottom: 1px solid var(--line-soft);
    display: flex; align-items: center; gap: 10px;
  }
  .drawer-head .oid { font-family: var(--mono); font-size: 14px; font-weight: 600; }
  .drawer-head .x {
    margin-left: auto; background: none; border: none; color: var(--muted);
    font-size: 16px; padding: 2px 6px; cursor: pointer;
  }
  .drawer-head .x:hover { color: #fff; }
  .drawer-body { overflow-y: auto; padding: 14px 16px; flex: 1; }
  .d-sec { margin-bottom: 16px; }
  .d-label {
    font-family: var(--mono); font-size: 10px; letter-spacing: 1.6px;
    color: var(--muted); text-transform: uppercase; margin-bottom: 6px;
  }
  .d-items { font-size: 13px; line-height: 1.5; }
  .d-addr { font-family: var(--mono); font-size: 12px; color: #aeb8c6; }
  .d-unit { font-family: var(--mono); font-size: 12px; }
  .drawer-body .muted { color: var(--muted); }
  .tl { list-style: none; margin: 0; padding: 0; }
  .tl li {
    display: flex; gap: 10px; padding: 6px 0;
    border-bottom: 1px solid var(--line-soft); font-size: 12px;
  }
  .tl .g { width: 16px; text-align: center; flex: none; font-family: var(--mono); }
  .tl .t { flex: 1; line-height: 1.4; }
  .tl .at { font-family: var(--mono); font-size: 10px; color: var(--faint); white-space: nowrap; }
```

- [ ] **Step 2: Add drawer markup**

Inside `<div id="map">`, immediately after the `.legend` div:

```html
    <div class="drawer" id="drawer">
      <div class="drawer-head">
        <span class="oid" id="dOid"></span>
        <span class="badge" id="dBadge"></span>
        <button class="x" id="dClose" title="close">✕</button>
      </div>
      <div class="drawer-body" id="dBody"></div>
    </div>
```

- [ ] **Step 3: Wire selection state and drawer rendering**

In the `<script>`, after `let map = null, mapReady = false;` add:

```js
let cfgGlobal = null;
let lastSnap = null;
let selectedOrderId = null;
let routeDrawnFor = null; // Task 3 uses this; declared here so stubs run

function drawRouteIfNeeded(o) {} // Task 3 replaces
function clearRoute() {}          // Task 3 replaces
```

In `boot()`, after `const cfg = await fetch(...)`: add `cfgGlobal = cfg;`

In `render(snap)`, first line: add `lastSnap = snap;` and at the end (after `renderMap(orders, byId);`): add `renderDrawer(orders, byId);`

In `renderOrders`, inside the `for (const o of feed)` loop after `card.style.borderLeftColor = color;`:

```js
    if (o.order_id === selectedOrderId) card.classList.add("sel");
    card.addEventListener("click", () => selectOrder(o.order_id));
```

Then add the drawer functions after `renderOrders`:

```js
function selectOrder(id) {
  selectedOrderId = id;
  routeDrawnFor = null;
  document.getElementById("drawer").classList.add("open");
  if (lastSnap) {
    const byId = Object.fromEntries(lastSnap.vehicles.map(v => [v.id, v]));
    renderDrawer(lastSnap.orders, byId);
  }
}

function closeDrawer() {
  if (!selectedOrderId) return;
  selectedOrderId = null;
  document.getElementById("drawer").classList.remove("open");
  clearRoute();
}

function fmtTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString([], { hour12: false });
}

// Merge status history + notifications + charges into one time-ordered feed.
function buildEvents(o) {
  const ev = [];
  const hist = (o.status_history && o.status_history.length)
    ? o.status_history
    : [{ status: o.status, at: o.updated_at }]; // legacy order: synthesize
  for (const h of hist) ev.push({
    at: h.at, glyph: "●", color: STATUS_COLOR[h.status] || "#8592a4",
    html: esc(String(h.status).replace(/_/g, " ")),
  });
  for (const n of (o.notifications || [])) ev.push({
    at: n.at, glyph: "✉", color: "#45b8f0",
    html: `${esc(n.channel)} “${esc(n.body)}” <span class="muted">${esc(n.status)}</span>`,
  });
  for (const t of (o.transactions || [])) ev.push({
    at: t.at, glyph: "$", color: t.kind === "refund" ? "#ff5d6c" : "#35d6a4",
    html: `${esc(t.kind)} $${(Number(t.amount) || 0).toFixed(2)} <span class="muted">${esc(t.status)}</span>`,
  });
  return ev.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

function renderDrawer(orders, byId) {
  if (!selectedOrderId) return;
  const o = orders.find(x => x.order_id === selectedOrderId);
  if (!o) { closeDrawer(); return; }

  const color = STATUS_COLOR[o.status] || "#8592a4";
  document.getElementById("dOid").textContent = o.order_id;
  const badge = document.getElementById("dBadge");
  badge.textContent = String(o.status).replace(/_/g, " ");
  badge.style.background = color;

  const v = o.assigned_vehicle ? byId[o.assigned_vehicle] : null;
  const unit = v
    ? `<b>${esc(v.id)}</b> · ${esc(v.type)} · <span class="muted">${esc(v.status)}</span>`
    : (o.assigned_vehicle ? esc(o.assigned_vehicle) : '<span class="muted">unassigned</span>');

  const items = (o.items || [])
    .map(i => `${Number(i.qty) || 0}× ${esc(i.name)}`).join("<br>") || "—";

  const tl = buildEvents(o).map(e => `
    <li><span class="g" style="color:${e.color}">${e.glyph}</span>
        <span class="t">${e.html}</span>
        <span class="at">${esc(fmtTime(e.at))}</span></li>`).join("");

  document.getElementById("dBody").innerHTML = `
    <div class="d-sec"><div class="d-label">Items</div><div class="d-items">${items}</div></div>
    <div class="d-sec"><div class="d-label">Drop</div><div class="d-addr">${esc(o.drop_address || "—")}</div></div>
    <div class="d-sec"><div class="d-label">Assigned Unit</div><div class="d-unit">${unit}</div></div>
    <div class="d-sec"><div class="d-label">Event Log</div><ul class="tl">${tl}</ul></div>`;

  drawRouteIfNeeded(o);
}
```

- [ ] **Step 4: Close handlers**

Near the other listener wiring at the bottom (before `boot();`):

```js
document.getElementById("dClose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
// click-away: any click on the map area outside the drawer closes it
document.getElementById("map").addEventListener("click", e => {
  if (e.target.closest && e.target.closest("#drawer")) return;
  closeDrawer();
});
```

- [ ] **Step 5: Verify in the browser**

```bash
npm run build
REDIS_URL= node dist/dashboard.js   # background it; serves http://localhost:3000
```

Open `http://localhost:3000` (Playwright browser tools work — no token needed; drawer works without map tiles). Check:
- Clicking an order ticket opens the drawer with id, badge, items, drop address, unit.
- Event log shows ● status entries in order; a delivered order also shows ✉ notifications and a $ charge, time-sorted.
- Drawer content updates as the sim advances the order (badge changes, log grows).
- ✕, Esc, and clicking the map each close it. Selected ticket is highlighted.

Then stop the dashboard process.

- [ ] **Step 6: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: order detail drawer with unified event log"
```

---

### Task 3: Highlighted route on the map

**Files:**
- Modify: `public/dashboard.html` (map init + replace the two stubs)

**Interfaces:**
- Consumes: `selectedOrderId`, `routeDrawnFor`, `cfgGlobal`, `mapReady`, `fc()`, and the `drawRouteIfNeeded(o)` / `clearRoute()` call sites from Task 2.
- Produces: real `drawRouteIfNeeded(order)` — fetches Mapbox Directions pickup→drop once per selection, renders on a `sel-route` layer, dims base layers; `clearRoute()` — empties the layer and restores opacity.

- [ ] **Step 1: Add the route source/layer at map load**

In `initMap`'s `map.on("load", ...)`, change `empty("lines"); empty("drops"); empty("vehicles");` to also create the route source, and add the layer between `drops` and `veh-glow` so vehicle dots stay on top:

```js
    empty("lines"); empty("drops"); empty("vehicles"); empty("sel-route");
```

and immediately after the `map.addLayer({ id: "drops", ... })` call:

```js
    map.addLayer({ id: "sel-route", type: "line", source: "sel-route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffb000", "line-width": 3, "line-opacity": 0.9 } });
```

- [ ] **Step 2: Replace the Task 2 stubs**

Delete the two stub lines (`function drawRouteIfNeeded(o) {}` / `function clearRoute() {}`) and add:

```js
function dimBase(on) {
  if (!mapReady) return;
  map.setPaintProperty("lines", "line-opacity", on ? 0.12 : 0.5);
  map.setPaintProperty("drops", "circle-opacity", on ? 0.25 : 1);
}

// One Directions call per selection (pickup→drop is stable); the moving
// vehicle dot conveys live progress. Falls back to a straight line when
// Directions fails; skips entirely when the order has no drop yet.
async function drawRouteIfNeeded(o) {
  if (!mapReady) return;
  if (routeDrawnFor === o.order_id) return;
  const from = o.pickup, to = o.drop;
  if (!from || !to) return; // no drop yet — retried on next tick's renderDrawer
  routeDrawnFor = o.order_id;
  dimBase(true);

  let geom = { type: "Feature", properties: {}, geometry: {
    type: "LineString", coordinates: [[from.lng, from.lat], [to.lng, to.lat]] } };
  try {
    if (cfgGlobal && cfgGlobal.mapboxToken) {
      const u = "https://api.mapbox.com/directions/v5/mapbox/driving/"
        + `${from.lng},${from.lat};${to.lng},${to.lat}`
        + `?geometries=geojson&overview=full&access_token=${cfgGlobal.mapboxToken}`;
      const r = await fetch(u);
      if (r.ok) {
        const j = await r.json();
        if (j.routes && j.routes[0]) {
          geom = { type: "Feature", properties: {}, geometry: j.routes[0].geometry };
        }
      }
    }
  } catch { /* keep straight-line fallback */ }

  if (selectedOrderId !== o.order_id) return; // closed/changed mid-fetch
  map.getSource("sel-route").setData(fc([geom]));
}

function clearRoute() {
  routeDrawnFor = null;
  if (!mapReady) return;
  map.getSource("sel-route").setData(fc([]));
  dimBase(false);
}
```

- [ ] **Step 3: Verify in the browser**

```bash
REDIS_URL= node dist/dashboard.js   # background it
```

With `MAPBOX_TOKEN` set in `.env`:
- Select an active order → bold amber road-following route pickup→drop; other lines/drops dim.
- Select a different order → route swaps. Close (✕/Esc/click-away) → route clears, opacity restores.
- Select a `created`/`routed` order with no vehicle → drawer works; route appears (pickup+drop exist from spawn).

Without a token (temporarily unset to check the fallback): drawer fully functional, "Map tiles unavailable" panel shows, no JS errors in console.

Stop the dashboard process.

- [ ] **Step 4: Final full pass (spec §Testing)**

Run: `npm run typecheck && npm run build`
Expected: exit 0. Re-run the dashboard once more and click through orders in each status you can catch (created, routed, assigned, out_for_delivery, exception, delivered) confirming drawer + timeline + unit + route per spec.

- [ ] **Step 5: Commit**

```bash
git add public/dashboard.html
git commit -m "feat: highlight selected order's road route on the map"
```
