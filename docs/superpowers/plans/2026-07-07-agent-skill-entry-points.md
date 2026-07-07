# Agent Skill Entry Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the 8 Otto subagents a skill entry point (`/<agent-name>`) that dispatches to it via `Task` and tells the user what to pass and what they get back.

**Architecture:** Each skill is a pure routing wrapper — one `.claude/skills/<agent-name>/SKILL.md` per agent. The `name:` equals the agent name (so trigger is `/<agent-name>`); the body dispatches to the matching `subagent_type` via the Task tool and carries a short input/output guide. No agent or `src/**` changes.

**Tech Stack:** Claude Code skills (Markdown + YAML frontmatter). No build, no runtime code.

## Global Constraints

- Skill files live at `.claude/skills/<agent-name>/SKILL.md`, exactly one per agent.
- Skill `name:` MUST equal the target agent name exactly (drives `/<name>` trigger).
- Skill `description:` MUST be when-to-use phrased (drives auto-trigger).
- Body MUST dispatch via the Task tool with `subagent_type: "<agent-name>"`; never inline the agent's work.
- Do NOT edit `.claude/agents/*` or `src/**`.
- No test suite exists; per-task verification is a filesystem/grep check, not a test run.

---

### Task 1: Orchestrator skill (main entry point)

**Files:**
- Create: `.claude/skills/delivery-orchestrator/SKILL.md`

**Interfaces:**
- Produces: the `/delivery-orchestrator` trigger; dispatches `subagent_type: "delivery-orchestrator"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/delivery-orchestrator/SKILL.md`:

```markdown
---
name: delivery-orchestrator
description: Run a delivery end-to-end — intake, routing, dispatch, tracking — with escalation to a human on unresolved exceptions. Entry point for a new order.
---
Main entry point for running a delivery. Advances one order through intake → routing →
dispatch → tracking, fanning out to each stage's subagent via Task and escalating to a
human on unresolved exceptions.

## What it does
Owns the full delivery lifecycle for one order and drives it to completion.

## Input you provide
A new order: customer, delivery address, items/quantities, and any time window. An
existing `order_id` to resume also works.

## How it runs
Use the Task tool with `subagent_type: "delivery-orchestrator"`. Pass the order details
as the task prompt. The orchestrator itself delegates each stage — do not call the stage
agents yourself here.

## Output
Final delivery status plus the persisted order state, or a one-line human-escalation
summary if something is stuck.
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: delivery-orchestrator$" .claude/skills/delivery-orchestrator/SKILL.md && grep -F 'subagent_type: "delivery-orchestrator"' .claude/skills/delivery-orchestrator/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/delivery-orchestrator/SKILL.md
git commit -m "feat: add /delivery-orchestrator skill entry point"
```

---

### Task 2: order-intake skill

**Files:**
- Create: `.claude/skills/order-intake/SKILL.md`

**Interfaces:**
- Produces: the `/order-intake` trigger; dispatches `subagent_type: "order-intake"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/order-intake/SKILL.md`:

```markdown
---
name: order-intake
description: Validate and structure an incoming order — normalize and geocode the delivery address and confirm serviceability.
---
Direct entry point to the Otto order-intake pipeline stage. The `delivery-orchestrator`
normally calls this; invoke it directly to run just this stage.

## What it does
Validates a raw order and returns a clean, geocoded order object with a serviceable flag.

## Input you provide
A raw order: delivery address plus items and quantities.

## How it runs
Use the Task tool with `subagent_type: "order-intake"`. Pass the raw order as the task
prompt. Do not do the work inline — route it to the subagent.

## Output
A structured order plus `serviceable: true/false`, or a specific rejection reason
(address unresolvable or out of range).
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: order-intake$" .claude/skills/order-intake/SKILL.md && grep -F 'subagent_type: "order-intake"' .claude/skills/order-intake/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/order-intake/SKILL.md
git commit -m "feat: add /order-intake skill entry point"
```

---

### Task 3: routing-planner skill

**Files:**
- Create: `.claude/skills/routing-planner/SKILL.md`

**Interfaces:**
- Produces: the `/routing-planner` trigger; dispatches `subagent_type: "routing-planner"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/routing-planner/SKILL.md`:

```markdown
---
name: routing-planner
description: Compute an optimal single- or multi-stop route factoring traffic, time windows, and vehicle constraints. Use after intake or for a re-plan.
---
Direct entry point to the Otto routing pipeline stage. The `delivery-orchestrator`
normally calls this; invoke it directly to run just this stage.

## What it does
Computes an optimal single- or multi-stop route given traffic, time windows, and vehicle
constraints.

## Input you provide
A pickup and one or more drop-off stops (or an `order_id`), plus vehicle type and time
windows if known.

## How it runs
Use the Task tool with `subagent_type: "routing-planner"`. Pass the stops and constraints
as the task prompt. Do not do the work inline — route it to the subagent.

## Output
An ordered route with legs and ETAs, plus any stops it could not assign.
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: routing-planner$" .claude/skills/routing-planner/SKILL.md && grep -F 'subagent_type: "routing-planner"' .claude/skills/routing-planner/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/routing-planner/SKILL.md
git commit -m "feat: add /routing-planner skill entry point"
```

---

### Task 4: fleet-dispatch skill

**Files:**
- Create: `.claude/skills/fleet-dispatch/SKILL.md`

**Interfaces:**
- Produces: the `/fleet-dispatch` trigger; dispatches `subagent_type: "fleet-dispatch"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/fleet-dispatch/SKILL.md`:

```markdown
---
name: fleet-dispatch
description: Assign an order to a courier, vehicle, or drone by availability, proximity, and capacity, once a route exists.
---
Direct entry point to the Otto fleet-dispatch pipeline stage. The `delivery-orchestrator`
normally calls this; invoke it directly to run just this stage.

## What it does
Assigns an order that already has a route to the best available courier, vehicle, or drone.

## Input you provide
An `order_id` (or order plus route) that has a route but no owner yet.

## How it runs
Use the Task tool with `subagent_type: "fleet-dispatch"`. Pass the order reference as the
task prompt. Do not do the work inline — route it to the subagent.

## Output
The assigned vehicle plus an assignment record — or the existing assignment if the order
was already dispatched.
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: fleet-dispatch$" .claude/skills/fleet-dispatch/SKILL.md && grep -F 'subagent_type: "fleet-dispatch"' .claude/skills/fleet-dispatch/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/fleet-dispatch/SKILL.md
git commit -m "feat: add /fleet-dispatch skill entry point"
```

---

### Task 5: delivery-tracker skill

**Files:**
- Create: `.claude/skills/delivery-tracker/SKILL.md`

**Interfaces:**
- Produces: the `/delivery-tracker` trigger; dispatches `subagent_type: "delivery-tracker"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/delivery-tracker/SKILL.md`:

```markdown
---
name: delivery-tracker
description: Monitor an in-progress delivery — live position, ETA, and geofence events.
---
Direct entry point to the Otto delivery-tracking pipeline stage. The
`delivery-orchestrator` normally calls this; invoke it directly to run just this stage.

## What it does
Monitors an in-progress delivery in real time: position, ETA, and geofence events.

## Input you provide
An assigned `order_id` that is currently out for delivery.

## How it runs
Use the Task tool with `subagent_type: "delivery-tracker"`. Pass the `order_id` as the
task prompt. Do not do the work inline — route it to the subagent.

## Output
Live position and ETA plus any geofence events, or `{live:false, reason}` when there is
no fix.
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: delivery-tracker$" .claude/skills/delivery-tracker/SKILL.md && grep -F 'subagent_type: "delivery-tracker"' .claude/skills/delivery-tracker/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/delivery-tracker/SKILL.md
git commit -m "feat: add /delivery-tracker skill entry point"
```

---

### Task 6: exception-recovery skill

**Files:**
- Create: `.claude/skills/exception-recovery/SKILL.md`

**Interfaces:**
- Produces: the `/exception-recovery` trigger; dispatches `subagent_type: "exception-recovery"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/exception-recovery/SKILL.md`:

```markdown
---
name: exception-recovery
description: Handle a delivery deviation — delay, failed drop-off, breakdown, or address problem.
---
Direct entry point to the Otto exception-recovery pipeline stage. The
`delivery-orchestrator` normally calls this; invoke it directly to run just this stage.

## What it does
Handles a delivery that has deviated from its plan and drives it back on track.

## Input you provide
The `order_id` and a description of what went wrong (delay, failed drop-off, breakdown,
address problem).

## How it runs
Use the Task tool with `subagent_type: "exception-recovery"`. Pass the order reference and
the problem description as the task prompt. Do not do the work inline — route it to the
subagent.

## Output
The recovery action taken (re-plan, re-assign, or retry) or a one-line human escalation.
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: exception-recovery$" .claude/skills/exception-recovery/SKILL.md && grep -F 'subagent_type: "exception-recovery"' .claude/skills/exception-recovery/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/exception-recovery/SKILL.md
git commit -m "feat: add /exception-recovery skill entry point"
```

---

### Task 7: customer-comms skill

**Files:**
- Create: `.claude/skills/customer-comms/SKILL.md`

**Interfaces:**
- Produces: the `/customer-comms` trigger; dispatches `subagent_type: "customer-comms"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/customer-comms/SKILL.md`:

```markdown
---
name: customer-comms
description: Send a proactive delivery update or answer a "where's my order" query.
---
Direct entry point to the Otto customer-comms pipeline stage. The `delivery-orchestrator`
normally calls this; invoke it directly to run just this stage.

## What it does
Sends a proactive delivery update or answers a customer's "where's my order" query.

## Input you provide
The `order_id` and the message intent — a status update, ETA, delay notice, or a customer
question to answer.

## How it runs
Use the Task tool with `subagent_type: "customer-comms"`. Pass the order reference and the
message intent as the task prompt. Do not do the work inline — route it to the subagent.

## Output
The sent-notification result (or a dry-run status when notify credentials are absent).
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: customer-comms$" .claude/skills/customer-comms/SKILL.md && grep -F 'subagent_type: "customer-comms"' .claude/skills/customer-comms/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/customer-comms/SKILL.md
git commit -m "feat: add /customer-comms skill entry point"
```

---

### Task 8: payment-settlement skill

**Files:**
- Create: `.claude/skills/payment-settlement/SKILL.md`

**Interfaces:**
- Produces: the `/payment-settlement` trigger; dispatches `subagent_type: "payment-settlement"`.

- [ ] **Step 1: Create the skill file**

Create `.claude/skills/payment-settlement/SKILL.md`:

```markdown
---
name: payment-settlement
description: Charge a customer, refund a failed delivery, or handle a payout.
---
Direct entry point to the Otto payment-settlement pipeline stage. The
`delivery-orchestrator` normally calls this; invoke it directly to run just this stage.

## What it does
Handles the money side of a delivery: charges, refunds, and payouts.

## Input you provide
The `order_id`, the amount, and the action (charge or refund). For a charge, include an
idempotency key.

## How it runs
Use the Task tool with `subagent_type: "payment-settlement"`. Pass the order reference,
amount, and action as the task prompt. Do not do the work inline — route it to the
subagent.

## Output
The charge or refund result, recorded against the order (dry-run status when Stripe
credentials are absent).
```

- [ ] **Step 2: Verify frontmatter and dispatch target**

Run: `grep -E "^name: payment-settlement$" .claude/skills/payment-settlement/SKILL.md && grep -F 'subagent_type: "payment-settlement"' .claude/skills/payment-settlement/SKILL.md`
Expected: both lines print (exit 0).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/payment-settlement/SKILL.md
git commit -m "feat: add /payment-settlement skill entry point"
```

---

## Final verification (after all tasks)

- [ ] **All 8 skills exist with matching names**

Run: `ls .claude/skills/*/SKILL.md | wc -l`
Expected: `8`

Run: `for d in .claude/skills/*/; do n=$(basename "$d"); grep -qE "^name: $n$" "$d/SKILL.md" && grep -qF "subagent_type: \"$n\"" "$d/SKILL.md" && echo "OK $n" || echo "FAIL $n"; done`
Expected: eight `OK <name>` lines, no `FAIL`.
