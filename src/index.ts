#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { config } from "./config.js";
import { ToolError } from "./errors.js";
import { haversine } from "./geo.js";
import { store, seedFleet, now } from "./store.js";
import * as maps from "./providers/mapbox.js";
import * as notify from "./providers/notify.js";
import * as stripe from "./providers/stripe.js";
import { solve as vrpSolve, type TimeWindow } from "./vrp.js";
import type { LatLng, Vehicle } from "./types.js";

// ── result helpers ──────────────────────────────────────────────────────────
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const fail = (e: unknown): ToolResult => {
  const payload =
    e instanceof ToolError
      ? e.toPayload()
      : { error: (e as Error)?.message ?? String(e), code: "provider_error", retriable: false };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
};

/** Wrap a handler so thrown ToolErrors become structured error results. */
function guard<A>(fn: (args: A) => Promise<unknown> | unknown) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

const latLng = z.object({ lat: z.number(), lng: z.number() });
const etaFrom = (durationS: number, departAt?: string): string => {
  const base = departAt ? new Date(departAt).getTime() : Date.now();
  return new Date(base + durationS * 1000).toISOString();
};

const server = new McpServer({ name: "otto", version: "0.1.0" });

// ═══ state ════════════════════════════════════════════════════════════════
server.registerTool(
  "state_read",
  {
    title: "state.read",
    description:
      "Fetch the current state of an order (status, items, pickup/drop coords, assigned vehicle, ETA, timestamps). Read-only, idempotent. Errors not_found if the order is unknown.",
    inputSchema: { order_id: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guard(async ({ order_id }: { order_id: string }) => {
    const o = await store.getOrder(order_id);
    if (!o) throw new ToolError("not_found", `No order ${order_id}.`);
    return o;
  })
);

server.registerTool(
  "state_write",
  {
    title: "state.write",
    description:
      "Update order state / advance its status. Upsert semantics, last-write-wins, never deletes. This is the mutation point — hold it only in the orchestrator, tracker, and exception agent.",
    inputSchema: {
      order_id: z.string(),
      status: z.string().optional(),
      fields: z.record(z.unknown()).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  guard(({ order_id, status, fields }: { order_id: string; status?: string; fields?: Record<string, unknown> }) =>
    store.upsertOrder(order_id, status as any, fields)
  )
);

// ═══ geocode ══════════════════════════════════════════════════════════════
server.registerTool(
  "geocode_validate",
  {
    title: "geocode.validate",
    description:
      "Check an address is well-formed and inside the service area. Returns { normalized_address, serviceable, reason }. Read-only. `reason` is specific on rejection: 'unparseable' vs 'out_of_range' so intake never guesses.",
    inputSchema: { address: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard(async ({ address }: { address: string }) => {
    let g: maps.GeocodeResult;
    try {
      g = await maps.geocode(address);
    } catch (e) {
      if (e instanceof ToolError && (e.code === "address_unparseable" || e.code === "address_ambiguous")) {
        return { normalized_address: null, serviceable: false, reason: "unparseable" };
      }
      throw e;
    }
    const dist = haversine(config.service.center, { lat: g.lat, lng: g.lng });
    const serviceable = dist <= config.service.radiusM;
    return {
      normalized_address: g.normalized_address,
      serviceable,
      reason: serviceable ? null : "out_of_range",
      distance_from_center_m: Math.round(dist),
    };
  })
);

server.registerTool(
  "geocode_geocode",
  {
    title: "geocode.geocode",
    description:
      "Resolve an address to coordinates. Returns { lat, lng, normalized_address, confidence }. Read-only, idempotent. REFUSES with address_ambiguous rather than returning low-confidence coordinates — a wrong pin cascades into bad routing.",
    inputSchema: { address: z.string() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard(async ({ address }: { address: string }) => {
    const g = await maps.geocode(address);
    if (g.confidence < config.geocodeMinConfidence) {
      throw new ToolError(
        "address_ambiguous",
        `Best match confidence ${g.confidence} below threshold ${config.geocodeMinConfidence}; refusing a low-confidence pin.`,
        { candidate: g }
      );
    }
    return g;
  })
);

// ═══ routing ══════════════════════════════════════════════════════════════
server.registerTool(
  "routing_directions",
  {
    title: "routing.directions",
    description:
      "Route between two points. Returns { distance_m, duration_s (traffic-adjusted), eta, geometry }. Read-only. Surfaces no_route when the pair is unreachable.",
    inputSchema: {
      origin: latLng,
      destination: latLng,
      depart_at: z.string().optional(),
      vehicle_type: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard(async (a: { origin: LatLng; destination: LatLng; depart_at?: string; vehicle_type?: string }) => {
    const d = await maps.directions(a.origin, a.destination, a.vehicle_type, a.depart_at);
    return {
      distance_m: Math.round(d.distance_m),
      duration_s: Math.round(d.duration_s),
      eta: etaFrom(d.duration_s, a.depart_at),
      geometry: d.geometry,
    };
  })
);

server.registerTool(
  "routing_matrix",
  {
    title: "routing.matrix",
    description:
      "Pairwise distance/duration matrices for a set of points. Returns N×N `distance` and `duration`. Read-only. Exists to feed vrp.solve so the solver isn't recomputing geometry.",
    inputSchema: { points: z.array(latLng).min(2), vehicle_type: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard((a: { points: LatLng[]; vehicle_type?: string }) => maps.matrix(a.points, a.vehicle_type))
);

// ═══ traffic ══════════════════════════════════════════════════════════════
server.registerTool(
  "traffic_current",
  {
    title: "traffic.current",
    description:
      "Congestion at a location/time. Returns { level: free|moderate|heavy, multiplier } where multiplier scales free-flow duration. Read-only. Kept separate so the traffic source can be swapped without touching routing.",
    inputSchema: { lat: z.number(), lng: z.number(), at: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard((a: { lat: number; lng: number; at?: string }) => maps.traffic({ lat: a.lat, lng: a.lng }, a.at))
);

// ═══ vrp ══════════════════════════════════════════════════════════════════
server.registerTool(
  "vrp_solve",
  {
    title: "vrp.solve",
    description:
      "Order multiple stops into optimal vehicle routes (capacity + time windows). Returns per-vehicle ordered stop sequences, per-route distance/duration, total cost, and any `unassigned` stops. Pure computation. Returns PARTIAL solutions with unassigned stops flagged rather than failing when constraints can't all be met. Pass `matrix` from routing.matrix; if omitted a straight-line fallback is used.",
    inputSchema: {
      depot: latLng,
      stops: z.array(latLng).min(1),
      num_vehicles: z.number().int().positive().optional(),
      vehicle_capacity: z.number().positive().optional(),
      demands: z.array(z.number()).optional(),
      time_windows: z.array(z.object({ start: z.number(), end: z.number() }).nullable()).optional(),
      matrix: z.object({ distance: z.array(z.array(z.number())), duration: z.array(z.array(z.number())) }).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guard(
    (a: {
      depot: LatLng;
      stops: LatLng[];
      num_vehicles?: number;
      vehicle_capacity?: number;
      demands?: number[];
      time_windows?: (TimeWindow | null)[];
      matrix?: { distance: number[][]; duration: number[][] };
    }) => {
      const pts = [a.depot, ...a.stops];
      let distance: number[][];
      let duration: number[][];
      if (a.matrix) {
        distance = a.matrix.distance;
        duration = a.matrix.duration;
      } else {
        // straight-line fallback: haversine meters, ~8.3 m/s (30 km/h) city speed
        distance = pts.map((p) => pts.map((q) => haversine(p, q)));
        duration = distance.map((row) => row.map((m) => m / 8.3));
      }
      const sol = vrpSolve({
        numVehicles: a.num_vehicles ?? 1,
        capacity: a.vehicle_capacity ?? Infinity,
        demands: a.demands ?? a.stops.map(() => 0),
        timeWindows: a.time_windows,
        distance,
        duration,
      });
      // annotate each route's sequence with the original stop coordinates
      return {
        ...sol,
        routes: sol.routes.map((r) => ({
          ...r,
          stops: r.sequence.map((i) => ({ index: i, ...a.stops[i - 1] })),
        })),
      };
    }
  )
);

// ═══ fleet ════════════════════════════════════════════════════════════════
async function availableVehicles(near?: LatLng, radiusM?: number, minCap?: number, type?: string): Promise<Vehicle[]> {
  return (await store.listVehicles())
    .filter((v) => v.status === "idle")
    .filter((v) => (minCap ? v.free_capacity >= minCap : true))
    .filter((v) => (type ? v.type === type : true))
    .filter((v) => (near && radiusM ? haversine(near, v.location) <= radiusM : true))
    .map((v) => ({ ...v, _dist: near ? haversine(near, v.location) : 0 } as Vehicle & { _dist: number }))
    .sort((a, b) => (a as any)._dist - (b as any)._dist);
}

server.registerTool(
  "fleet_list_available",
  {
    title: "fleet.list_available",
    description:
      "Couriers/vehicles that could take a job. Returns matching fleet resources sorted by distance, each { id, type, location, free_capacity, status }. Read-only.",
    inputSchema: {
      near: latLng.optional(),
      radius_m: z.number().positive().optional(),
      min_capacity: z.number().positive().optional(),
      vehicle_type: z.string().optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guard(async (a: { near?: LatLng; radius_m?: number; min_capacity?: number; vehicle_type?: string }) =>
    (await availableVehicles(a.near, a.radius_m, a.min_capacity, a.vehicle_type)).map(
      ({ id, type, location, free_capacity, status }) => ({ id, type, location, free_capacity, status })
    )
  )
);

server.registerTool(
  "fleet_assign",
  {
    title: "fleet.assign",
    description:
      "Commit an order to a fleet resource (auto-picks the best if vehicle_id is omitted). Returns { assigned_vehicle, reason } or { assigned:false, reason }. NOT idempotent and stateful: flips a vehicle to busy and writes the assignment. Re-calling for an already-assigned order returns the EXISTING assignment instead of grabbing a second vehicle.",
    inputSchema: { order_id: z.string(), vehicle_id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  guard(async (a: { order_id: string; vehicle_id?: string }) => {
    const order = await store.ensureOrder(a.order_id);

    // Double-assignment guard: already has a live assignment → return it.
    if (order.assigned_vehicle) {
      return { assigned: true, assigned_vehicle: order.assigned_vehicle, reason: "already_assigned" };
    }

    const near = (order.drop ?? order.pickup) as LatLng | undefined;
    let vehicle: Vehicle | undefined;
    if (a.vehicle_id) {
      vehicle = await store.getVehicle(a.vehicle_id);
      if (!vehicle) throw new ToolError("not_found", `No vehicle ${a.vehicle_id}.`);
      if (vehicle.status !== "idle")
        return { assigned: false, reason: `vehicle ${a.vehicle_id} is ${vehicle.status}` };
    } else {
      vehicle = (await availableVehicles(near, undefined, 1))[0];
      if (!vehicle) return { assigned: false, reason: "all_busy_or_no_capacity" };
    }

    // commit: flip vehicle busy, write assignment onto the order
    vehicle.status = "busy";
    vehicle.free_capacity = Math.max(0, vehicle.free_capacity - 1);
    vehicle.assigned_order = a.order_id;
    await store.setVehicle(vehicle);
    await store.upsertOrder(a.order_id, "assigned", { assigned_vehicle: vehicle.id });

    const why = near ? `nearest idle ${vehicle.type} with capacity` : `idle ${vehicle.type} with capacity`;
    return { assigned: true, assigned_vehicle: vehicle.id, reason: why };
  })
);

// ═══ telemetry ════════════════════════════════════════════════════════════
server.registerTool(
  "telemetry_position",
  {
    title: "telemetry.position",
    description:
      "Current location + progress of an in-flight delivery. Returns { lat, lng, progress: 0-1, recomputed_eta, last_update }. Read-only. If there's no live fix (order not out for delivery, or no coords), it says so via { live:false, reason } rather than returning a stale point silently.",
    inputSchema: { order_id: z.string().optional(), vehicle_id: z.string().optional() },
    annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard(async (a: { order_id?: string; vehicle_id?: string }) => {
    if (!a.order_id && !a.vehicle_id)
      throw new ToolError("invalid_input", "Provide order_id or vehicle_id.");

    const order = a.order_id ? await store.getOrder(a.order_id) : undefined;
    if (a.order_id && !order) throw new ToolError("not_found", `No order ${a.order_id}.`);

    const vehId = order?.assigned_vehicle ?? a.vehicle_id ?? undefined;
    const veh = vehId ? await store.getVehicle(vehId) : undefined;

    if (!veh?.location || !order?.pickup || !order?.drop) {
      return { live: false, reason: "no_live_fix", last_update: null };
    }
    const total = haversine(order.pickup, order.drop) || 1;
    const done = haversine(order.pickup, veh.location);
    const progress = Math.max(0, Math.min(1, done / total));
    const remaining = haversine(veh.location, order.drop);
    const recomputed_eta = etaFrom(remaining / 8.3);
    return {
      live: true,
      lat: veh.location.lat,
      lng: veh.location.lng,
      progress: Number(progress.toFixed(3)),
      recomputed_eta,
      last_update: now(),
    };
  })
);

// ═══ geofence ═════════════════════════════════════════════════════════════
server.registerTool(
  "geofence_check",
  {
    title: "geofence.check",
    description:
      "Which fences a point has entered. Loads an order's pickup/drop fences (via order_id) or uses inline `fences[]`. Returns fired fences { name, distance_m } — arrived-at-pickup, near-drop-off, arrived. Read-only, pure.",
    inputSchema: {
      lat: z.number(),
      lng: z.number(),
      order_id: z.string().optional(),
      fences: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number(), radius_m: z.number() })).optional(),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  guard(async (a: { lat: number; lng: number; order_id?: string; fences?: { name: string; lat: number; lng: number; radius_m: number }[] }) => {
    const here: LatLng = { lat: a.lat, lng: a.lng };
    let fences = a.fences ?? [];
    if (a.order_id) {
      const o = await store.getOrder(a.order_id);
      if (!o) throw new ToolError("not_found", `No order ${a.order_id}.`);
      if (o.pickup) fences.push({ name: "arrived_at_pickup", lat: o.pickup.lat, lng: o.pickup.lng, radius_m: 50 });
      if (o.drop) {
        fences.push({ name: "near_drop_off", lat: o.drop.lat, lng: o.drop.lng, radius_m: 300 });
        fences.push({ name: "arrived", lat: o.drop.lat, lng: o.drop.lng, radius_m: 50 });
      }
    }
    const fired = fences
      .map((f) => ({ name: f.name, distance_m: Math.round(haversine(here, { lat: f.lat, lng: f.lng })), radius_m: f.radius_m }))
      .filter((f) => f.distance_m <= f.radius_m)
      .map(({ name, distance_m }) => ({ name, distance_m }));
    return { fired };
  })
);

// ═══ notify ═══════════════════════════════════════════════════════════════
server.registerTool(
  "notify_send",
  {
    title: "notify.send",
    description:
      "Message the customer. Returns { notification_id, status }. SIDE-EFFECTING — reaches a real person, so it warrants a confirm/permission gate in a live deployment. Every send is logged against the order. Runs DRY-RUN (status 'dry_run', no send) when the channel's provider creds are absent.",
    inputSchema: {
      order_id: z.string().optional(),
      channel: z.enum(["sms", "email", "push"]),
      to: z.string(),
      body: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  guard(async (a: { order_id?: string; channel: notify.Channel; to: string; body: string }) => {
    const r = await notify.send(a.channel, a.to, a.body);
    const notification_id = `ntf_${r.provider_id}`;
    if (a.order_id) {
      const o = await store.ensureOrder(a.order_id);
      o.notifications.push({
        notification_id,
        channel: a.channel,
        to: a.to,
        body: a.body,
        status: r.status,
        at: now(),
      });
      await store.upsertOrder(a.order_id, undefined, { notifications: o.notifications });
    }
    return { notification_id, status: r.status };
  })
);

// ═══ payments ═════════════════════════════════════════════════════════════
server.registerTool(
  "payments_charge",
  {
    title: "payments.charge",
    description:
      "Take payment. Returns { transaction_id, status }. DESTRUCTIVE/financial and idempotent: idempotency_key is REQUIRED, and a repeat key returns the original result instead of charging twice. Runs DRY-RUN when STRIPE_SECRET_KEY is absent.",
    inputSchema: {
      order_id: z.string(),
      amount: z.number().positive(),
      currency: z.string().default("usd"),
      idempotency_key: z.string(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard(async (a: { order_id: string; amount: number; currency: string; idempotency_key: string }) => {
    const prior = await store.getIdempotent(a.idempotency_key);
    if (prior) return { ...(prior as object), replayed: true };

    let result: { transaction_id: string; status: string };
    if (!stripe.stripeEnabled()) {
      result = { transaction_id: `dry_${a.idempotency_key}`, status: "dry_run_succeeded" };
    } else {
      const r = await stripe.createCharge({
        amount: a.amount,
        currency: a.currency,
        idempotencyKey: a.idempotency_key,
        orderId: a.order_id,
      });
      result = { transaction_id: r.transaction_id, status: r.status };
    }

    const o = await store.ensureOrder(a.order_id);
    o.transactions.push({
      transaction_id: result.transaction_id,
      kind: "charge",
      amount: a.amount,
      currency: a.currency,
      status: result.status,
      idempotency_key: a.idempotency_key,
      at: now(),
    });
    await store.upsertOrder(a.order_id, undefined, { transactions: o.transactions });
    await store.setIdempotent(a.idempotency_key, result);
    return result;
  })
);

server.registerTool(
  "payments_refund",
  {
    title: "payments.refund",
    description:
      "Reverse a charge. Returns { refund_id, status }. Validates a prior successful charge exists and that the refund doesn't exceed it (net of earlier refunds). Financial and guarded. Runs DRY-RUN when STRIPE_SECRET_KEY is absent.",
    inputSchema: {
      order_id: z.string(),
      amount: z.number().positive().optional(),
      reason: z.string(),
      idempotency_key: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard(async (a: { order_id: string; amount?: number; reason: string; idempotency_key?: string }) => {
    if (a.idempotency_key) {
      const prior = await store.getIdempotent(a.idempotency_key);
      if (prior) return { ...(prior as object), replayed: true };
    }
    const o = await store.getOrder(a.order_id);
    if (!o) throw new ToolError("not_found", `No order ${a.order_id}.`);

    const charge = [...o.transactions].reverse().find(
      (t) => t.kind === "charge" && /succeed|success|dry_run_succeeded/i.test(t.status)
    );
    if (!charge)
      throw new ToolError("invalid_input", "No successful charge on this order to refund.");

    const charged = charge.amount;
    const alreadyRefunded = o.transactions
      .filter((t) => t.kind === "refund")
      .reduce((s, t) => s + t.amount, 0);
    const refundAmount = a.amount ?? charged - alreadyRefunded;
    if (refundAmount <= 0)
      throw new ToolError("invalid_input", "Nothing left to refund on this order.");
    if (alreadyRefunded + refundAmount > charged + 1e-9)
      throw new ToolError(
        "invalid_input",
        `Refund ${refundAmount} exceeds remaining ${charged - alreadyRefunded} of charge ${charge.transaction_id}.`
      );

    let result: { refund_id: string; status: string };
    if (!stripe.stripeEnabled()) {
      result = { refund_id: `dry_refund_${Date.now()}`, status: "dry_run_succeeded" };
    } else {
      const r = await stripe.createRefund({
        chargeOrIntentId: charge.transaction_id,
        amount: refundAmount,
        reason: a.reason,
        idempotencyKey: a.idempotency_key,
      });
      result = { refund_id: r.refund_id, status: r.status };
    }

    o.transactions.push({
      transaction_id: result.refund_id,
      kind: "refund",
      amount: refundAmount,
      currency: charge.currency,
      status: result.status,
      idempotency_key: a.idempotency_key,
      reason: a.reason,
      ref: charge.transaction_id,
      at: now(),
    });
    await store.upsertOrder(a.order_id, undefined, { transactions: o.transactions });
    if (a.idempotency_key) await store.setIdempotent(a.idempotency_key, result);
    return result;
  })
);

// ── boot ─────────────────────────────────────────────────────────────────
async function main() {
  await seedFleet(); // populate demo fleet before any tool can fire
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the MCP channel and must stay clean.
  console.error("otto MCP server ready — 15 tools registered.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
