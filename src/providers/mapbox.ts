import { requireMapboxToken } from "../config.js";
import { ToolError, fromHttp } from "../errors.js";
import type { LatLng } from "../types.js";

const BASE = "https://api.mapbox.com";

async function get(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new ToolError("provider_error", `Network error calling Mapbox: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw fromHttp(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError("provider_error", `Malformed Mapbox response: ${text.slice(0, 200)}`);
  }
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  normalized_address: string;
  confidence: number;
}

/**
 * Forward geocode via Mapbox Search v6. Returns the best match with a
 * confidence in [0,1]. Throws address_unparseable when nothing matches.
 */
export async function geocode(address: string): Promise<GeocodeResult> {
  const token = requireMapboxToken();
  const url =
    `${BASE}/search/geocode/v6/forward` +
    `?q=${encodeURIComponent(address)}&limit=1&access_token=${token}`;
  const data = await get(url);
  const feat = data?.features?.[0];
  if (!feat) {
    throw new ToolError("address_unparseable", `No geocode match for "${address}".`);
  }
  const [lng, lat] = feat.geometry?.coordinates ?? [];
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw new ToolError("address_unparseable", `Match had no coordinates for "${address}".`);
  }
  // v6 exposes match_code.confidence ("exact"|"high"|"medium"|"low") and a
  // numeric relevance-like score is not returned; map the enum to [0,1].
  const enumConf: Record<string, number> = { exact: 1, high: 0.85, medium: 0.6, low: 0.35 };
  const raw = feat.properties?.match_code?.confidence as string | undefined;
  const confidence = raw ? enumConf[raw] ?? 0.5 : 0.7;
  const normalized_address =
    feat.properties?.full_address || feat.properties?.name || address;
  return { lat, lng, normalized_address, confidence };
}

export interface DirectionsResult {
  distance_m: number;
  duration_s: number; // traffic-adjusted
  duration_typical_s: number; // free-flow, for deriving a multiplier
  geometry: unknown;
}

function profileFor(vehicleType?: string): string {
  // driving-traffic gives live-traffic durations; cycling/walking for couriers.
  switch (vehicleType) {
    case "courier":
    case "walk":
      return "mapbox/walking";
    case "bike":
    case "cycle":
      return "mapbox/cycling";
    default:
      return "mapbox/driving-traffic";
  }
}

export async function directions(
  origin: LatLng,
  destination: LatLng,
  vehicleType?: string,
  departAt?: string
): Promise<DirectionsResult> {
  const token = requireMapboxToken();
  const profile = profileFor(vehicleType);
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const params = new URLSearchParams({
    access_token: token,
    overview: "full",
    geometries: "geojson",
    annotations: "duration,distance,congestion_numeric",
  });
  if (departAt) params.set("depart_at", departAt);
  const url = `${BASE}/directions/v5/${profile}/${coords}?${params}`;
  const data = await get(url);
  if (data.code && data.code !== "Ok") {
    if (data.code === "NoRoute" || data.code === "NoSegment")
      throw new ToolError("no_route", `No route between the points (${data.code}).`);
    throw new ToolError("provider_error", `Mapbox directions: ${data.code} ${data.message ?? ""}`);
  }
  const route = data.routes?.[0];
  if (!route) throw new ToolError("no_route", "No route returned.");
  return {
    distance_m: route.distance,
    duration_s: route.duration,
    duration_typical_s: route.duration_typical ?? route.duration,
    geometry: route.geometry,
  };
}

export interface MatrixResult {
  distance: number[][]; // meters
  duration: number[][]; // seconds (traffic-adjusted)
}

export async function matrix(points: LatLng[], vehicleType?: string): Promise<MatrixResult> {
  const token = requireMapboxToken();
  if (points.length < 2) throw new ToolError("invalid_input", "matrix needs at least 2 points.");
  if (points.length > 25)
    throw new ToolError("invalid_input", "Mapbox matrix caps at 25 coordinates per call.");
  const profile = profileFor(vehicleType);
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const params = new URLSearchParams({ access_token: token, annotations: "distance,duration" });
  const url = `${BASE}/directions-matrix/v1/${profile}/${coords}?${params}`;
  const data = await get(url);
  if (data.code && data.code !== "Ok")
    throw new ToolError("provider_error", `Mapbox matrix: ${data.code} ${data.message ?? ""}`);
  return { distance: data.distances, duration: data.durations };
}

export type TrafficLevel = "free" | "moderate" | "heavy";

export interface TrafficResult {
  level: TrafficLevel;
  multiplier: number; // scales free-flow duration
}

/**
 * Derive congestion at a point by sampling a short driving-traffic leg and
 * comparing live duration to the typical (free-flow) duration.
 */
export async function traffic(at: LatLng, _when?: string): Promise<TrafficResult> {
  // small offset (~250m east) to form a legal 1-leg route through the point
  const near: LatLng = { lat: at.lat, lng: at.lng + 0.0025 };
  const d = await directions(at, near, undefined);
  const multiplier =
    d.duration_typical_s > 0 ? d.duration_s / d.duration_typical_s : 1;
  let level: TrafficLevel = "free";
  if (multiplier >= 1.5) level = "heavy";
  else if (multiplier >= 1.15) level = "moderate";
  return { level, multiplier: Number(multiplier.toFixed(3)) };
}
