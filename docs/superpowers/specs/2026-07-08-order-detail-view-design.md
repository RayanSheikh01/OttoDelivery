# Order Detail View — Design

**Date:** 2026-07-08
**Status:** Approved, ready for planning

## Goal

Let a dashboard user click an order and inspect it in depth: every status change over
time, which vehicle it is assigned to, and its route highlighted on the map.

## Decisions (locked)

- **Detail UI:** slide-in drawer overlaying the right edge of the map. Map stays
  visible behind it so the highlighted route reads. Close via ✕, click-away, or Esc.
- **Route render:** real road-following path from the Mapbox Directions API, fetched
  client-side once per selection (pickup → drop). Other order lines dim so the
  selection pops.
- **Timeline scope:** unified event log — status transitions, notifications, and
  charges merged into one time-ordered feed.

## Architecture

The dashboard already streams whole orders over SSE (`/api/events`) including
`notifications[]` and `transactions[]`, and already hands the client the Mapbox token
via `/api/config`. The only missing datum is a record of status transitions. So the
work is: add status history at the store's single mutation point, then build the
client-side drawer + route rendering against data that is already on the wire.

### 1. Data layer — status history

- Add to `Order` (`src/types.ts`):
  ```ts
  status_history?: { status: OrderStatus; at: string }[];
  ```
- In `store.upsertOrder` (`src/store.ts`): after resolving `next.status`, append
  `{ status: next.status, at: now() }` to `next.status_history` when either there is
  no history yet (seed the first entry) or the resolved status differs from
  `base.status`. Because every writer — the simulator tick loop **and** the real
  Claude agents via `state.write` — funnels through `upsertOrder`, this captures all
  transitions with no caller changes.
- **Missing-history guard:** if a read returns an order with no `status_history`
  (e.g. an order created before this change under Redis), the client synthesizes a
  single entry `[{ status, at: updated_at }]` so the UI never renders empty. No
  server-side backfill needed.
- Notifications and transactions already carry `at` timestamps and need no change;
  they are merged into the event log purely on the client.

### 2. Transport

No new endpoints. `status_history` serializes automatically once it is on the `Order`
type and written by `upsertOrder`; the SSE snapshot already sends the full order
object. `/api/config` already exposes `mapboxToken` for the client Directions call.

### 3. Frontend — slide-in drawer (`public/dashboard.html`)

- Order tickets in the feed become clickable (`cursor:pointer`): a click sets a
  module-level `selectedOrderId` and opens the drawer.
- Drawer is an absolutely-positioned panel over the map column, revealed with a CSS
  `transform: translateX` slide transition, matching the existing dark panel styling
  (`--panel`, mono/display fonts, status color vars already defined).
- Drawer contents:
  - Header: `order_id`, status badge (reuse `STATUS_COLOR`), close ✕.
  - Summary: items list, `drop_address`, **assigned unit** — id, type, and live
    status pulled from the vehicle map in the current snapshot.
  - **Unified event log:** build an array by merging
    `status_history` (glyph ●), `notifications` (glyph ✉, show body + channel), and
    `transactions` (glyph $, show kind + amount + status), each tagged with its `at`,
    then sort ascending by `at` and render as a timeline.
- **Live updates:** `render(snap)` already runs on every SSE tick. When
  `selectedOrderId` is set, re-render the drawer from the fresh order each tick, so
  the timeline grows and the status advances in place while the drawer stays open.
- **Close:** ✕ button, click on the map/backdrop outside the drawer, or Esc key —
  each clears `selectedOrderId`, hides the drawer, and clears the route layer.
- All store-sourced strings pass through the existing `esc()` helper before hitting
  `innerHTML`.

### 4. Map — highlighted route

- On selection, if the order has both a pickup (depot/center) and a drop, `fetch`
  `https://api.mapbox.com/directions/v5/mapbox/driving/{lng,lat};{lng,lat}?geometries=geojson&overview=full&access_token=…`
  and set the returned geometry on a new `sel-route` GeoJSON source, drawn by a
  `sel-route` line layer (amber `#ffb000`, width ~3, full opacity) added above the
  existing `lines` layer.
- Fetch is **pickup → drop** (a stable path), so it is one request per selection, not
  one per tick — the moving vehicle dot conveys live progress on its own.
- While a selection is active, reduce the base `lines` and `drops` layer opacity so
  the highlighted route stands out; restore on close.
- **Fallbacks:** order has no drop yet (created/routed) → skip the route, drawer still
  works. Directions request fails, or no Mapbox token / map not initialized → fall
  back to a bold straight pickup→drop line (or, with no map, simply no route). Clear
  the `sel-route` source on close.

## Scope guard (YAGNI)

Out of scope: order filtering/search, historical replay/scrubbing, editing an order
from the drawer, and any persistence beyond what Redis already provides. Terminal
(delivered/cancelled) and unassigned orders simply display whatever data exists.

## Testing / verification

The repo has no test suite or linter — `typecheck` is the only automated check.

1. `npm run typecheck` and `npm run build` pass.
2. Run the dashboard, click orders in each status (created, routed, assigned,
   out_for_delivery, exception, delivered); confirm the drawer opens, the timeline
   shows merged status/notify/charge events in time order, the assigned unit is
   correct, and the route highlights (real road path when a drop + token exist,
   straight-line fallback otherwise).
3. Confirm the drawer updates live across ticks and closes via ✕, click-away, and Esc.
