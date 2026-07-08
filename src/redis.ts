import { Redis } from "ioredis";

import { config } from "./config.js";

/**
 * Shared Redis client. When REDIS_URL is set, the store uses this as its
 * source of truth (so state survives restarts and can be shared across the MCP
 * server + dashboard processes). When unset, `redis` is null and the store
 * falls back to in-memory Maps — the same dry-run degrade the providers use.
 *
 * stdout is the MCP channel — diagnostics go to stderr only.
 */
export const redis: Redis | null = config.redisUrl
  ? new Redis(config.redisUrl, { maxRetriesPerRequest: 3 })
  : null;

if (redis) {
  redis.on("error", (e: Error) => console.error("redis error:", e.message));
  redis.on("connect", () => console.error(`redis connected: ${config.redisUrl}`));
}

export function redisEnabled(): boolean {
  return redis !== null;
}

export const FLEET_MIN = 1;
export const FLEET_MAX = 10;

// Hash keys — one hash per collection, field = entity id.
export const RK = {
  orders: "otto:orders",
  vehicles: "otto:vehicles",
  idem: "otto:idem",
} as const;
