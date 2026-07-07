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
