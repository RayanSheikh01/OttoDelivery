import type { Order, OrderStatus, Vehicle } from "./types.js";
import { redis, redisEnabled, RK, FLEET_MIN, FLEET_MAX } from "./redis.js";
import { config } from "./config.js";

/**
 * Shared order/vehicle/idempotency store. Two backends:
 *
 *  - REDIS_URL set  → Redis hashes are the source of truth. State survives
 *    restarts and is shared across processes (MCP server + dashboard).
 *  - REDIS_URL unset → in-memory Maps (single-process, resets on restart).
 *
 * Every method is async so callers don't care which backend is live.
 *
 * Concurrency note: with Redis, a read-modify-write (upsertOrder, fleet
 * double-assign guard, payment idempotency) is NOT atomic across the `await`
 * boundary — two truly-concurrent clients can interleave. That was safe under
 * the old single-thread + sync-Map design. For a single agent driving the
 * server it stays effectively serial; harden with WATCH/Lua if you run
 * concurrent clients.
 */
const orders = new Map<string, Order>();
const vehicles = new Map<string, Vehicle>();
const paymentIdempotency = new Map<string, unknown>();

function now(): string {
  return new Date().toISOString();
}

export const store = {
  // ── orders ──────────────────────────────────────────────────────────────
  async getOrder(id: string): Promise<Order | undefined> {
    if (redisEnabled()) {
      const raw = await redis!.hget(RK.orders, id);
      return raw ? (JSON.parse(raw) as Order) : undefined;
    }
    return orders.get(id);
  },

  /** Upsert with last-write-wins. Never deletes. */
  async upsertOrder(
    id: string,
    status: OrderStatus | undefined,
    fields: Record<string, unknown> | undefined
  ): Promise<Order> {
    const existing = await this.getOrder(id);
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

    const nextStatus: OrderStatus =
      status ?? (fields?.status as OrderStatus) ?? base.status;
    // Append a history entry on the first write and on every status change.
    // upsertOrder is the single mutation point, so the simulator and the real
    // agents (via state.write) both get recorded with no caller changes.
    const prevHistory = base.status_history ?? [];
    const status_history =
      prevHistory.length === 0 ||
      prevHistory[prevHistory.length - 1].status !== nextStatus
        ? [...prevHistory, { status: nextStatus, at: now() }]
        : prevHistory;

    const next: Order = {
      ...base,
      ...(fields ?? {}),
      order_id: id, // never let a patch rewrite identity
      status: nextStatus,
      status_history, // after the fields spread so a patch can't clobber it
      updated_at: now(),
      created_at: base.created_at,
    };
    if (redisEnabled()) {
      await redis!.hset(RK.orders, id, JSON.stringify(next));
    } else {
      orders.set(id, next);
    }
    return next;
  },

  async ensureOrder(id: string): Promise<Order> {
    return (await this.getOrder(id)) ?? this.upsertOrder(id, "created", {});
  },

  /** Snapshot of every order — used by the dashboard/simulator. */
  async listOrders(): Promise<Order[]> {
    if (redisEnabled()) {
      const all = await redis!.hgetall(RK.orders);
      return Object.values(all).map((j) => JSON.parse(j) as Order);
    }
    return [...orders.values()];
  },

  // ── fleet ───────────────────────────────────────────────────────────────
  async getVehicle(id: string): Promise<Vehicle | undefined> {
    if (redisEnabled()) {
      const raw = await redis!.hget(RK.vehicles, id);
      return raw ? (JSON.parse(raw) as Vehicle) : undefined;
    }
    return vehicles.get(id);
  },
  async listVehicles(): Promise<Vehicle[]> {
    if (redisEnabled()) {
      const all = await redis!.hgetall(RK.vehicles);
      return Object.values(all).map((j) => JSON.parse(j) as Vehicle);
    }
    return [...vehicles.values()];
  },
  async setVehicle(v: Vehicle): Promise<void> {
    if (redisEnabled()) {
      await redis!.hset(RK.vehicles, v.id, JSON.stringify(v));
    } else {
      vehicles.set(v.id, v);
    }
  },
  async removeVehicle(id: string): Promise<void> {
    if (redisEnabled()) {
      await redis!.hdel(RK.vehicles, id);
    } else {
      vehicles.delete(id);
    }
  },

  // ── payment idempotency ───────────────────────────────────────────────────
  async getIdempotent(key: string): Promise<unknown | undefined> {
    if (redisEnabled()) {
      const raw = await redis!.hget(RK.idem, key);
      return raw ? JSON.parse(raw) : undefined;
    }
    return paymentIdempotency.get(key);
  },
  async setIdempotent(key: string, value: unknown): Promise<void> {
    if (redisEnabled()) {
      await redis!.hset(RK.idem, key, JSON.stringify(value));
    } else {
      paymentIdempotency.set(key, value);
    }
  },
};

/** Seed a small fleet so fleet.* tools return something on a fresh process. */
export async function seedFleet(): Promise<void> {
  if ((await store.listVehicles()).length > 0) return;
  const seed: Vehicle[] = [
    { id: "veh-001", type: "courier", location: { lat: 40.7128, lng: -74.006 }, free_capacity: 3, status: "idle" },
    { id: "veh-002", type: "car", location: { lat: 40.7306, lng: -73.9866 }, free_capacity: 8, status: "idle" },
    { id: "veh-003", type: "van", location: { lat: 40.7484, lng: -73.9857 }, free_capacity: 20, status: "idle" },
    { id: "veh-004", type: "drone", location: { lat: 40.7061, lng: -74.0087 }, free_capacity: 1, status: "idle" },
    { id: "veh-005", type: "car", location: { lat: 40.6782, lng: -73.9442 }, free_capacity: 8, status: "busy" },
  ];
  for (const v of seed) await store.setVehicle(v);
}

// Vehicle archetypes cycled when the fleet grows past the seed set.
const FLEET_TEMPLATES: Array<Pick<Vehicle, "type" | "free_capacity">> = [
  { type: "courier", free_capacity: 3 },
  { type: "car", free_capacity: 8 },
  { type: "van", free_capacity: 20 },
  { type: "drone", free_capacity: 1 },
];

/** Numeric suffix of a `veh-NNN` id, or 0 if it doesn't match. */
function vehNum(id: string): number {
  const m = /^veh-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/**
 * Grow or shrink the fleet to exactly `target` vehicles (clamped 1–10).
 * Growing appends fresh idle units near the depot. Shrinking removes idle,
 * unassigned units first; if it must remove a busy unit to hit the target, that
 * unit's order is released back to `routed` so another vehicle can pick it up.
 * Returns the resulting vehicle list.
 */
export async function scaleFleet(target: number): Promise<Vehicle[]> {
  const n = Math.max(FLEET_MIN, Math.min(FLEET_MAX, Math.round(target)));
  let list = await store.listVehicles();

  // grow
  let nextNum = list.reduce((max, v) => Math.max(max, vehNum(v.id)), 0);
  while (list.length < n) {
    const tpl = FLEET_TEMPLATES[nextNum % FLEET_TEMPLATES.length];
    nextNum += 1;
    await store.setVehicle({
      id: `veh-${String(nextNum).padStart(3, "0")}`,
      type: tpl.type,
      location: { ...config.service.center },
      free_capacity: tpl.free_capacity,
      status: "idle",
    });
    list = await store.listVehicles();
  }

  // shrink — idle+unassigned first, then busy (releasing their order)
  if (list.length > n) {
    const removable = [...list].sort((a, b) => rank(a) - rank(b));
    for (const v of removable) {
      if (list.length <= n) break;
      if (v.assigned_order) {
        await store.upsertOrder(v.assigned_order, "routed", { assigned_vehicle: null });
      }
      await store.removeVehicle(v.id);
      list = await store.listVehicles();
    }
  }

  return list;
}

// Lower rank = removed sooner. Idle & unassigned go first, busy last.
function rank(v: Vehicle): number {
  if (v.status === "idle" && !v.assigned_order) return 0;
  if (v.status === "offline" && !v.assigned_order) return 1;
  return 2;
}

export { now };
