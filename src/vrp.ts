import { ToolError } from "./errors.js";

export interface TimeWindow {
  start: number; // seconds from departure
  end: number;
}

export interface VrpInput {
  numVehicles: number;
  capacity: number; // per vehicle; Infinity if unset
  demands: number[]; // length = stops.length
  timeWindows?: (TimeWindow | null)[];
  distance: number[][]; // (n+1) x (n+1), index 0 = depot
  duration: number[][]; // (n+1) x (n+1)
}

export interface VrpRoute {
  vehicle: number;
  sequence: number[]; // 1-based stop indices in visit order
  distance_m: number;
  duration_s: number;
}

export interface VrpSolution {
  routes: VrpRoute[];
  unassigned: number[]; // 1-based stop indices that couldn't be placed
  total_distance_m: number;
  total_duration_s: number;
  total_cost: number;
}

/** Reverse the segment [i..k] of a route in place. */
function twoOptSwap(route: number[], i: number, k: number): number[] {
  return [...route.slice(0, i), ...route.slice(i, k + 1).reverse(), ...route.slice(k + 1)];
}

function routeDistance(seq: number[], distance: number[][]): number {
  // seq is stop indices (1-based); depot is 0 at both ends
  let prev = 0;
  let total = 0;
  for (const s of seq) {
    total += distance[prev][s];
    prev = s;
  }
  total += distance[prev][0];
  return total;
}

function routeDuration(seq: number[], duration: number[][]): number {
  let prev = 0;
  let total = 0;
  for (const s of seq) {
    total += duration[prev][s];
    prev = s;
  }
  total += duration[prev][0];
  return total;
}

/** Check that visiting seq respects every stop's time window (if any). */
function windowsOk(seq: number[], duration: number[][], tw?: (TimeWindow | null)[]): boolean {
  if (!tw) return true;
  let t = 0;
  let prev = 0;
  for (const s of seq) {
    t += duration[prev][s];
    const w = tw[s - 1];
    if (w) {
      if (t > w.end) return false;
      if (t < w.start) t = w.start; // wait until window opens
    }
    prev = s;
  }
  return true;
}

/**
 * Capacitated VRP with optional time windows. Greedy nearest-neighbor
 * construction per vehicle, then per-route 2-opt improvement. Returns a
 * PARTIAL solution with `unassigned` populated rather than throwing when
 * constraints can't all be met — the exception agent needs that signal.
 */
export function solve(input: VrpInput): VrpSolution {
  const n = input.demands.length;
  if (input.distance.length !== n + 1 || input.duration.length !== n + 1) {
    throw new ToolError(
      "invalid_input",
      `Matrix must be ${n + 1}x${n + 1} (depot + ${n} stops); got ${input.distance.length}.`
    );
  }

  const remaining = new Set<number>();
  for (let i = 1; i <= n; i++) remaining.add(i);

  const routes: VrpRoute[] = [];

  for (let v = 0; v < input.numVehicles && remaining.size > 0; v++) {
    let load = 0;
    let seq: number[] = [];
    let at = 0; // depot

    // nearest-neighbor build respecting capacity + windows
    while (true) {
      let best = -1;
      let bestD = Infinity;
      for (const s of remaining) {
        const demand = input.demands[s - 1] ?? 0;
        if (load + demand > input.capacity) continue;
        if (!windowsOk([...seq, s], input.duration, input.timeWindows)) continue;
        const d = input.distance[at][s];
        if (d < bestD) {
          bestD = d;
          best = s;
        }
      }
      if (best === -1) break;
      seq.push(best);
      load += input.demands[best - 1] ?? 0;
      at = best;
      remaining.delete(best);
    }

    if (seq.length === 0) continue;

    // 2-opt local improvement, skipping swaps that break time windows
    let improved = true;
    while (improved && seq.length > 2) {
      improved = false;
      const baseD = routeDistance(seq, input.distance);
      for (let i = 0; i < seq.length - 1; i++) {
        for (let k = i + 1; k < seq.length; k++) {
          const cand = twoOptSwap(seq, i, k);
          if (!windowsOk(cand, input.duration, input.timeWindows)) continue;
          if (routeDistance(cand, input.distance) + 1e-6 < baseD) {
            seq = cand;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
    }

    routes.push({
      vehicle: v,
      sequence: seq,
      distance_m: Math.round(routeDistance(seq, input.distance)),
      duration_s: Math.round(routeDuration(seq, input.duration)),
    });
  }

  const total_distance_m = routes.reduce((a, r) => a + r.distance_m, 0);
  const total_duration_s = routes.reduce((a, r) => a + r.duration_s, 0);

  return {
    routes,
    unassigned: [...remaining].sort((a, b) => a - b),
    total_distance_m,
    total_duration_s,
    total_cost: total_distance_m, // cost model = total meters; swap as needed
  };
}
