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
