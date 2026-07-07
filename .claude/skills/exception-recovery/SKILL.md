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
