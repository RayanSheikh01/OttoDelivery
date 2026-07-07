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
