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
