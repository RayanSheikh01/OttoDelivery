# Design: Skill entry points for Otto delivery agents

**Date:** 2026-07-07
**Status:** Approved

## Problem

The 8 subagents in `.claude/agents/` are only reachable when another agent
(the orchestrator) dispatches them via `Task`. A user has no direct, discoverable
way to invoke a single agent — there is no `/order-intake` command, no way to run
just the routing stage for debugging, and no auto-triggered natural-language entry.

## Goal

Give each agent a skill that acts as its entry point: a discoverable slash command
(`/<agent-name>`) that also auto-triggers on relevant natural-language requests, and
that dispatches to the corresponding subagent while telling the user what to pass and
what they get back.

## Scope

- **In:** 8 new `SKILL.md` files, one per existing agent.
- **Out:** No changes to `.claude/agents/*`, no changes to `src/**`, no shared helper
  skill, no argument-schema validation. Skills are pure routing wrappers.

## Layout

One file per agent:

```
.claude/skills/<agent-name>/SKILL.md
```

Skill `name:` equals the agent name exactly, so the slash trigger is `/<agent-name>`:

| Skill / trigger          | Dispatches to subagent   | Framing                          |
|--------------------------|--------------------------|----------------------------------|
| `/delivery-orchestrator` | `delivery-orchestrator`  | Main entry — run a delivery e2e  |
| `/order-intake`          | `order-intake`           | Direct stage: validate order     |
| `/routing-planner`       | `routing-planner`        | Direct stage: plan route         |
| `/fleet-dispatch`        | `fleet-dispatch`         | Direct stage: assign vehicle     |
| `/delivery-tracker`      | `delivery-tracker`       | Direct stage: track in progress  |
| `/exception-recovery`    | `exception-recovery`     | Direct stage: handle deviation   |
| `/customer-comms`        | `customer-comms`         | Direct stage: message customer   |
| `/payment-settlement`    | `payment-settlement`     | Direct stage: charge / refund    |

## SKILL.md structure

Each file: frontmatter + a dispatcher-with-guide body.

```markdown
---
name: <agent-name>
description: <when-to-use phrasing — drives both /trigger and auto-trigger>
---
## What it does
<one line, derived from the agent's own purpose>

## Input you provide
<what the user passes: order id, raw address, items, failure reason, etc.>

## How it runs
Use the Task tool with subagent_type "<agent-name>". Pass the user's request
as the task prompt. Do not do the work inline — route it to the subagent.

## Output
<what comes back: structured order, route, assignment, ETA, charge result, ...>
```

## Framing rules

- `delivery-orchestrator` skill is the **main entry point**. Its body states it advances
  an order intake → routing → dispatch → tracking and fans out to the other stages via
  `Task` itself. This is what a user reaches for to "run a delivery."
- The other 7 skills are **direct access to a single pipeline stage** — for manual runs
  or debugging. Each body notes: "The orchestrator normally calls this; invoke it
  directly to run just this stage."

## Descriptions (auto-trigger)

Each `description:` is reworded from the source agent's `description:` into when-to-use
form, so the skill fires on both `/<name>` and natural-language phrasing. Names are
agent-specific, so there is no collision between skills.

Per-agent description source (`.claude/agents/<name>.md` → skill `description:`):

- **delivery-orchestrator** — "Run a delivery end-to-end: intake, routing, dispatch,
  tracking, with escalation to a human on unresolved exceptions. Entry point for a new order."
- **order-intake** — "Validate and structure an incoming order; normalize + geocode the
  address and confirm serviceability."
- **routing-planner** — "Compute an optimal single- or multi-stop route factoring traffic,
  time windows, and vehicle constraints; also for re-plans."
- **fleet-dispatch** — "Assign an order to a courier, vehicle, or drone by availability,
  proximity, and capacity, once a route exists."
- **delivery-tracker** — "Monitor an in-progress delivery: position, ETA, geofence events."
- **exception-recovery** — "Handle a delivery deviation: delay, failed drop-off, breakdown,
  or address problem."
- **customer-comms** — "Send a proactive delivery update or answer a 'where's my order' query."
- **payment-settlement** — "Charge a customer, refund a failed delivery, or handle a payout."

## Error handling

None added at the skill layer. Skills only route. All real failure handling stays in the
subagents and the `mcp__otto__*` tools (which already return the `ToolError` taxonomy).

## Testing

No automated test surface (project has none; `typecheck` covers `src/` only, untouched here).
Manual verification: each skill appears as a `/<agent-name>` command and dispatches to the
matching subagent. Correct dispatch is confirmed by the subagent's own tool calls appearing.

## Success criteria

- 8 `SKILL.md` files exist under `.claude/skills/<agent-name>/`.
- Each `name:` matches its agent; each `description:` is when-to-use phrased.
- Each body dispatches to the matching `subagent_type` via `Task`, with input/output guide.
- `delivery-orchestrator` framed as main entry; the other 7 framed as direct-stage access.
- No edits to `.claude/agents/*` or `src/**`.
