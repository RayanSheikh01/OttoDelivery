import { EventEmitter } from "node:events";

import { config } from "./config.js";
import { haversine } from "./geo.js";
import { store, now } from "./store.js";
import type { LatLng, Order, OrderStatus, Vehicle } from "./types.js";

/**
 * Mock delivery simulator. Drives orders through the real lifecycle on a tick
 * loop and nudges vehicles toward their drops — all against the shared in-memory
 * store, so the dashboard renders genuine store state. Offline-safe: uses plain
 * lat/lng math, never calls Mapbox (map tiles are a client-side concern).
 *
 * Emits "tick" with a fresh snapshot after every step and control action.
 */

export interface Snapshot {
  orders: Order[];
  vehicles: Vehicle[];
  service: typeof config.service;
  running: boolean;
  at: string;
}

const ITEM_POOL = [
  "Burrito Bowl", "Margherita Pizza", "Pad Thai", "Cheeseburger", "Sushi Platter",
  "Caesar Salad", "Ramen", "Falafel Wrap", "Fried Chicken", "Iced Latte",
  "Bubble Tea", "Croissant", "Poke Bowl", "Tacos al Pastor", "Dumplings",
];

const EARTH_R = 6371000;
const ARRIVE_M = 50; // geofence "arrived" threshold, matches geofence_check
const STEP_M = 850; // vehicle travel per tick
const SPAWN_MAX_M = 9000; // keep drops close so deliveries finish quickly on-screen

/** Uniform random point within `maxMeters` of `center`. */
function randomPointWithin(center: LatLng, maxMeters: number): LatLng {
  const d = Math.sqrt(Math.random()) * maxMeters;
  const brng = Math.random() * 2 * Math.PI;
  const dNorth = d * Math.cos(brng);
  const dEast = d * Math.sin(brng);
  const lat = center.lat + (dNorth / EARTH_R) * (180 / Math.PI);
  const lng =
    center.lng +
    (dEast / (EARTH_R * Math.cos((center.lat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lng };
}

/** Step `from` toward `to` by up to `meters`; returns `to` once within reach. */
function moveToward(from: LatLng, to: LatLng, meters: number): LatLng {
  const d = haversine(from, to);
  if (d <= meters || d === 0) return { ...to };
  const t = meters / d;
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
}

function randomItems() {
  const n = 1 + Math.floor(Math.random() * 3);
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({ name: ITEM_POOL[Math.floor(Math.random() * ITEM_POOL.length)], qty: 1 + Math.floor(Math.random() * 2) });
  }
  return items;
}

const ACTIVE: OrderStatus[] = ["created", "routed", "assigned", "out_for_delivery", "exception"];

export class Simulator extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;
  private running = false;
  private ticking = false; // re-entrancy guard: store I/O is async now
  readonly tickMs: number;

  constructor(tickMs = 2500) {
    super();
    this.tickMs = tickMs;
  }

  start(): void {
    if (this.timer) return;
    this.running = true;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    void this.emitSnapshot();
  }

  pause(): void {
    this.running = false;
    void this.emitSnapshot();
  }

  resume(): void {
    this.running = true;
    void this.emitSnapshot();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async snapshot(): Promise<Snapshot> {
    return {
      orders: await store.listOrders(),
      vehicles: await store.listVehicles(),
      service: config.service,
      running: this.running,
      at: now(),
    };
  }

  private async emitSnapshot(): Promise<void> {
    this.emit("tick", await this.snapshot());
  }

  /** Cancel every active order and return all vehicles to idle. */
  async reset(): Promise<void> {
    for (const o of await store.listOrders()) {
      if (ACTIVE.includes(o.status)) {
        await store.upsertOrder(o.order_id, "cancelled", { assigned_vehicle: null });
      }
    }
    for (const v of await store.listVehicles()) {
      await store.setVehicle({ ...v, status: "idle", assigned_order: null });
    }
    await this.emitSnapshot();
  }

  /** Force-create one order immediately (demo button). */
  async spawnNow(): Promise<void> {
    await this.spawn();
    await this.emitSnapshot();
  }

  private async spawn(): Promise<void> {
    const id = `ord-${String(++this.seq).padStart(4, "0")}`;
    const drop = randomPointWithin(config.service.center, SPAWN_MAX_M);
    await store.upsertOrder(id, "created", {
      items: randomItems(),
      pickup: { ...config.service.center }, // depot / kitchen
      drop,
      drop_address: `${100 + Math.floor(Math.random() * 900)} Demo St`,
    });
  }

  private async tick(): Promise<void> {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    try {
      // Occasionally place a new order.
      if (Math.random() < 0.55) await this.spawn();

      for (const o of await store.listOrders()) {
        await this.advance(o);
      }
      await this.emitSnapshot();
    } finally {
      this.ticking = false;
    }
  }

  private async advance(o: Order): Promise<void> {
    switch (o.status) {
      case "created":
        await store.upsertOrder(o.order_id, "routed", {});
        break;

      case "routed": {
        const v = await this.nearestIdle(o.drop);
        if (!v) return; // no capacity — wait (visible backpressure)
        await store.setVehicle({
          ...v,
          status: "busy",
          assigned_order: o.order_id,
          free_capacity: Math.max(0, v.free_capacity - 1),
        });
        await store.upsertOrder(o.order_id, "assigned", { assigned_vehicle: v.id });
        break;
      }

      case "assigned":
        await store.upsertOrder(o.order_id, "out_for_delivery", {});
        // customer-comms: "on the way" update
        await this.logNotification(o.order_id, "Your order is on the way.");
        break;

      case "out_for_delivery": {
        const v = o.assigned_vehicle ? await store.getVehicle(o.assigned_vehicle) : undefined;
        const drop = o.drop as LatLng | undefined;
        if (!v || !drop) return;

        // rare hiccup, recovers next tick
        if (Math.random() < 0.04) {
          await store.upsertOrder(o.order_id, "exception", { exception_reason: "traffic delay" });
          return;
        }

        const next = moveToward(v.location, drop, STEP_M);
        await store.setVehicle({ ...v, location: next });

        if (haversine(next, drop) <= ARRIVE_M) {
          await store.upsertOrder(o.order_id, "delivered", { eta: now(), delivered_at: now() });
          await store.setVehicle({
            ...(await store.getVehicle(v.id))!,
            status: "idle",
            assigned_order: null,
            free_capacity: v.free_capacity + 1,
          });
          // customer-comms + payment-settlement close out the order
          await this.logNotification(o.order_id, "Delivered. Enjoy!");
          await this.logCharge(o.order_id);
        }
        break;
      }

      case "exception":
        await store.upsertOrder(o.order_id, "out_for_delivery", { exception_reason: null });
        break;

      default:
        break; // delivered / cancelled / failed — terminal
    }
  }

  private async logNotification(orderId: string, body: string): Promise<void> {
    const o = await store.getOrder(orderId);
    if (!o) return;
    const notifications = [
      ...o.notifications,
      { notification_id: `ntf-${Math.random().toString(36).slice(2, 8)}`, channel: "sms" as const, to: "+15550000000", body, status: "dry_run", at: now() },
    ];
    await store.upsertOrder(orderId, undefined, { notifications });
  }

  private async logCharge(orderId: string): Promise<void> {
    const o = await store.getOrder(orderId);
    if (!o) return;
    const amount = 8 + Math.round(Math.random() * 3400) / 100; // demo total
    const transactions = [
      ...o.transactions,
      { transaction_id: `txn-${Math.random().toString(36).slice(2, 8)}`, kind: "charge" as const, amount, currency: "usd", status: "dry_run_succeeded", at: now() },
    ];
    await store.upsertOrder(orderId, undefined, { transactions });
  }

  private async nearestIdle(near?: LatLng): Promise<Vehicle | undefined> {
    const idle = (await store.listVehicles()).filter(
      (v) => v.status === "idle" && v.free_capacity > 0
    );
    if (!near) return idle[0];
    return idle.sort((a, b) => haversine(a.location, near) - haversine(b.location, near))[0];
  }
}
