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
