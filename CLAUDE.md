# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single MCP server (`otto`) that exposes 15 tools for a delivery pipeline, plus 8 Claude Code subagent definitions in `.claude/agents/` that call those tools. The server is stdio-transport (`src/index.ts` boots `StdioServerTransport`); Claude Code auto-loads it from `.mcp.json`, which runs the compiled `dist/index.js`. Tools surface to agents as `mcp__otto__<tool>` (e.g. `mcp__otto__state_read`).

## Commands

```bash
npm install
npm run build       # tsc -> dist/  (REQUIRED before the MCP server can load)
npm run typecheck   # tsc --noEmit — fast validity check
npm run dev         # tsc -w — watch/recompile
npm start           # node dist/index.js — run the server standalone (rarely needed)
```

There is **no test suite and no linter** — `typecheck` is the only automated check. After changing any `src/**` file you must `npm run build` and **restart the Claude Code session** before the rebuilt tools take effect (the server is a long-lived child process). Env config lives in `.env`; copy from `.env.example` and set at least `MAPBOX_TOKEN` or all map tools throw.

## Architecture

**Shared in-memory store is the backbone.** Because the whole server is one process, every tool reads/writes the same maps in `src/store.ts` (`orders`, `vehicles`, and a `paymentIdempotency` ledger). This is deliberate — it is the "shared order store every agent reads from." Consequences to keep in mind:
- State resets on server restart (i.e. on every rebuild). Nothing is persisted.
- `store.upsertOrder` is last-write-wins and never deletes; `order_id` is never rewritten by a patch. Orders carry a free-form `[key: string]: unknown` patch surface, so `state.write` can stash spec-open fields without a schema change.
- `seedFleet()` runs at boot to populate 5 demo vehicles so `fleet.*` returns something on a fresh process.

**Tool registration is all in `src/index.ts`** — one `server.registerTool` call per tool, each with a `guard()`-wrapped handler. `guard` turns thrown `ToolError`s into structured `{error, code, retriable}` results (`isError: true`) instead of crashing. When adding a tool, follow this pattern and set MCP `annotations` (readOnly/destructive/idempotent) honestly — agents route on them.

**Error taxonomy (`src/errors.ts`) is load-bearing.** Every failure is a `ToolError` with a `UpstreamCode` and a `retriable` boolean. Retriable = `rate_limited`, `provider_error`. Everything else (`no_route`, `address_unparseable`, `address_ambiguous`, `out_of_range`, `not_found`, `invalid_input`) is terminal — it tells an agent "this can't be delivered, stop retrying." `fromHttp()` maps provider HTTP statuses onto these codes. Preserve this distinction; agents depend on it.

**Providers are swappable and degrade to dry-run:**
- `src/providers/mapbox.ts` — real Mapbox wrapper for geocode / directions / matrix / traffic. `traffic.current` has no dedicated feed: it samples a ~250m driving-traffic leg and compares live vs. typical duration to derive a multiplier. Directions picks a profile by vehicle type (walking for courier, cycling for bike, else driving-traffic).
- `src/providers/notify.ts` (Twilio/SendGrid) and `src/providers/stripe.ts` — real wrappers that fall back to **dry-run** when creds are absent (`status: "dry_run"` / `"dry_run_succeeded"`, no external effect). This is the safety property: nothing texts a real person or moves real money until keys are set. Keep it.

**Safety-critical tool behaviors (don't regress these):**
- `geocode.geocode` refuses (`address_ambiguous`) below `OTTO_GEOCODE_MIN_CONFIDENCE` rather than returning a wrong pin that would cascade into bad routing.
- `fleet.assign` is guarded against double-assignment — re-calling for an assigned order returns the existing assignment instead of grabbing a second vehicle.
- `payments.charge` **requires** `idempotency_key` and replays the stored result on a repeat key. `payments.refund` validates a prior successful charge exists and that cumulative refunds don't exceed it.
- `telemetry.position` returns `{live:false, reason}` when it has no fix rather than a stale point. It has no real GPS upstream — it derives progress from the assigned vehicle's stored `location`.

**VRP solver (`src/vrp.ts`)** is pure: greedy nearest-neighbor construction respecting capacity + time windows, then per-route 2-opt. It returns **partial** solutions with an `unassigned[]` list rather than throwing when constraints can't all be met — the exception agent needs that signal. `vrp.solve` accepts a precomputed matrix from `routing.matrix`; without one it falls back to haversine distance at ~8.3 m/s.

## Agent pipeline (`.claude/agents/`)

`delivery-orchestrator` is the entry point and the only supervisor: it advances an order intake → routing → dispatch → tracking by delegating each stage via `Task`, persisting status after every transition, and escalating to a human on unresolved exceptions. It never does a subagent's work itself. Supporting agents: `order-intake`, `routing-planner`, `fleet-dispatch`, `delivery-tracker`, `exception-recovery`, `customer-comms`, `payment-settlement`. Each agent's `tools:` frontmatter grants only the `mcp__otto__*` tools it needs — mutation tools (`state.write`) are intentionally held by only the orchestrator, tracker, and exception agent.

## Conventions

- ESM throughout (`"type": "module"`, `NodeNext`). Relative imports **must** use the `.js` extension even from `.ts` source (e.g. `import { store } from "./store.js"`).
- `strict` TypeScript is on.
- stdout is the MCP channel — **never** `console.log`. Diagnostics go to `console.error` (stderr) only.
