import type { LatLng } from "./types.js";

const R = 6371000; // earth radius, meters

/** Great-circle distance in meters between two points. */
export function haversine(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isLatLng(v: unknown): v is LatLng {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as LatLng).lat === "number" &&
    typeof (v as LatLng).lng === "number"
  );
}
