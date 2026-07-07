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
