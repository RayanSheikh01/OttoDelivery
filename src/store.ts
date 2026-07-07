import type { Order, OrderStatus, Vehicle } from "./types.js";

/**
 * Single-process in-memory stores. Because the whole server is one process,
 * every tool shares these maps directly — this is the "shared order store
 * every agent reads from" the spec calls for.
 */
const orders = new Map<string, Order>();
const vehicles = new Map<string, Vehicle>();

// Idempotency ledger for payments: key -> the result we returned the first time.
const paymentIdempotency = new Map<string, unknown>();

function now(): string {
  return new Date().toISOString();
}

export const store = {
  // ── orders ──────────────────────────────────────────────────────────────
  getOrder(id: string): Order | undefined {
    return orders.get(id);
  },

  /** Upsert with last-write-wins. Never deletes. */
  upsertOrder(
    id: string,
    status: OrderStatus | undefined,
    fields: Record<string, unknown> | undefined
  ): Order {
    const existing = orders.get(id);
    const base: Order =
      existing ??
      ({
        order_id: id,
        status: "created",
        items: [],
        notifications: [],
        transactions: [],
        created_at: now(),
        updated_at: now(),
        assigned_vehicle: null,
        eta: null,
      } as Order);

    const next: Order = {
      ...base,
      ...(fields ?? {}),
      order_id: id, // never let a patch rewrite identity
      status: status ?? (fields?.status as OrderStatus) ?? base.status,
      updated_at: now(),
      created_at: base.created_at,
    };
    orders.set(id, next);
    return next;
  },

  ensureOrder(id: string): Order {
    return orders.get(id) ?? this.upsertOrder(id, "created", {});
  },

  // ── fleet ───────────────────────────────────────────────────────────────
  getVehicle(id: string): Vehicle | undefined {
    return vehicles.get(id);
  },
  listVehicles(): Vehicle[] {
    return [...vehicles.values()];
  },
  setVehicle(v: Vehicle): void {
    vehicles.set(v.id, v);
  },

  // ── payment idempotency ───────────────────────────────────────────────────
  getIdempotent(key: string): unknown | undefined {
    return paymentIdempotency.get(key);
  },
  setIdempotent(key: string, value: unknown): void {
    paymentIdempotency.set(key, value);
  },
};

/** Seed a small fleet so fleet.* tools return something on a fresh process. */
export function seedFleet(): void {
  if (vehicles.size > 0) return;
  const seed: Vehicle[] = [
    { id: "veh-001", type: "courier", location: { lat: 40.7128, lng: -74.006 }, free_capacity: 3, status: "idle" },
    { id: "veh-002", type: "car", location: { lat: 40.7306, lng: -73.9866 }, free_capacity: 8, status: "idle" },
    { id: "veh-003", type: "van", location: { lat: 40.7484, lng: -73.9857 }, free_capacity: 20, status: "idle" },
    { id: "veh-004", type: "drone", location: { lat: 40.7061, lng: -74.0087 }, free_capacity: 1, status: "idle" },
    { id: "veh-005", type: "car", location: { lat: 40.6782, lng: -73.9442 }, free_capacity: 8, status: "busy" },
  ];
  for (const v of seed) vehicles.set(v.id, v);
}

export { now };
