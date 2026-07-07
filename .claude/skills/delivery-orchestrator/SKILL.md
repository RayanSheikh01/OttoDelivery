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
