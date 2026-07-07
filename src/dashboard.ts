#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

import { config } from "./config.js";
import { store, seedFleet } from "./store.js";
import { Simulator, type Snapshot } from "./simulator.js";
import type { VehicleStatus } from "./types.js";

/**
 * Standalone HTTP + SSE dashboard for the Otto delivery pipeline. Runs the mock
 * simulator against the shared in-memory store and serves a live map UI. This is
 * a separate entry from the stdio MCP server (src/index.ts) — stdout is never the
 * MCP channel here, but we still log to stderr only, per repo convention.
 */

const PORT = Number(process.env.OTTO_DASHBOARD_PORT) || 3000;
const HTML_URL = new URL("../public/dashboard.html", import.meta.url);

seedFleet();
const sim = new Simulator();

// ── SSE fan-out ─────────────────────────────────────────────────────────────
const clients = new Set<ServerResponse>();
sim.on("tick", (snap: Snapshot) => {
  const frame = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) res.write(frame);
});

function json(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // ── static ──
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      const html = await readFile(HTML_URL, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ── config (token + service area for the map) ──
    if (req.method === "GET" && path === "/api/config") {
      json(res, 200, { mapboxToken: config.mapboxToken, service: config.service, tickMs: sim.tickMs });
      return;
    }

    // ── snapshot ──
    if (req.method === "GET" && path === "/api/state") {
      json(res, 200, sim.snapshot());
      return;
    }

    // ── live stream ──
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(sim.snapshot())}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    // ── simulator controls ──
    if (req.method === "POST" && path.startsWith("/api/sim/")) {
      const action = path.slice("/api/sim/".length);
      switch (action) {
        case "pause": sim.pause(); break;
        case "resume": sim.resume(); break;
        case "spawn": sim.spawnNow(); break;
        case "reset": sim.reset(); break;
        default: return json(res, 404, { error: "unknown action" });
      }
      json(res, 200, { ok: true, running: sim.isRunning() });
      return;
    }

    // ── fleet management: toggle a vehicle's status ──
    if (req.method === "POST" && path === "/api/fleet") {
      const body = await readBody(req);
      const v = body.id ? store.getVehicle(body.id) : undefined;
      if (!v) return json(res, 404, { error: "vehicle not found" });
      const status = body.status as VehicleStatus;
      if (!["idle", "busy", "offline"].includes(status)) return json(res, 400, { error: "bad status" });
      store.setVehicle({ ...v, status });
      json(res, 200, { ok: true });
      // reflect the change immediately
      for (const c of clients) c.write(`data: ${JSON.stringify(sim.snapshot())}\n\n`);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("dashboard request error:", e);
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => {
  sim.start();
  console.error(`otto dashboard on http://localhost:${PORT}  (sim tick ${sim.tickMs}ms)`);
  if (!config.mapboxToken) console.error("warning: MAPBOX_TOKEN unset — map tiles will not render.");
});
