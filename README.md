# OttoDelivery MCP server

One MCP server (`otto`) exposing the 15 tools the delivery subagents call, plus
the 8 agent definitions in [.claude/agents/](.claude/agents/).

Single process → one shared in-memory order store, which is exactly what the
spec's "shared order store every agent reads from" wants. Map tools are real
wrappers over Mapbox; `notify` (Twilio/SendGrid) and `payments` (Stripe) are real
wrappers that fall back to **dry-run** when their creds are absent, so nothing
reaches a real person or moves real money until you add keys.

## Setup

```bash
npm install
cp .env.example .env      # add MAPBOX_TOKEN (+ optional Twilio/Stripe keys)
npm run build
```

Claude Code auto-loads the server from [.mcp.json](.mcp.json). Restart the session
after building; tools then appear as `mcp__otto__<tool>`.

## Tool map

| Spec name | Tool id | Hints |
|---|---|---|
| state.read | `mcp__otto__state_read` | readOnly, idempotent |
| state.write | `mcp__otto__state_write` | mutation, last-write-wins |
| geocode.validate | `mcp__otto__geocode_validate` | readOnly |
| geocode.geocode | `mcp__otto__geocode_geocode` | readOnly; refuses low confidence |
| routing.directions | `mcp__otto__routing_directions` | readOnly; traffic-adjusted |
| routing.matrix | `mcp__otto__routing_matrix` | readOnly |
| traffic.current | `mcp__otto__traffic_current` | readOnly |
| vrp.solve | `mcp__otto__vrp_solve` | pure; returns partials + unassigned |
| fleet.list_available | `mcp__otto__fleet_list_available` | readOnly |
| fleet.assign | `mcp__otto__fleet_assign` | stateful; double-assign guarded |
| telemetry.position | `mcp__otto__telemetry_position` | readOnly; `live:false` on no fix |
| geofence.check | `mcp__otto__geofence_check` | pure |
| notify.send | `mcp__otto__notify_send` | side-effecting; dry-run w/o creds |
| payments.charge | `mcp__otto__payments_charge` | destructive; idempotency_key required |
| payments.refund | `mcp__otto__payments_refund` | destructive; validates prior charge |

## Error taxonomy (map tools)

Errors carry `{ code, retriable }` so agents can tell "try again" from "can't be
delivered": `rate_limited` / `provider_error` (retriable), `no_route`,
`address_unparseable`, `address_ambiguous`, `out_of_range`, `not_found`,
`invalid_input` (terminal). See [src/errors.ts](src/errors.ts).

## Notes / prod gaps

- **telemetry.position** has no real GPS upstream — it derives progress from the
  assigned vehicle's stored `location` (which a real fleet webhook would update)
  and reports `live:false` when it can't. Wire a tracking provider for production.
- **payments.charge** uses Stripe's `pm_card_visa` test payment method; swap in a
  real saved payment method before taking live money.
- **traffic.current** derives a multiplier by sampling a short driving-traffic leg
  through the point and comparing to free-flow. Swap `src/providers/mapbox.ts` for
  a dedicated traffic feed if you have one.
- Store is in-memory; it resets when the server restarts. Back it with Redis/DB
  for persistence across restarts.
