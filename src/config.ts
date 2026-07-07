import { readFileSync } from "node:fs";

/** Load .env (if present) into process.env without adding a dependency. */
function loadDotenv(): void {
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m || line.trimStart().startsWith("#")) continue;
      const key = m[1];
      let val = m[2];
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* no .env — rely on real env vars */
  }
}
loadDotenv();

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  mapProvider: (process.env.MAP_PROVIDER || "mapbox").toLowerCase(),
  mapboxToken: process.env.MAPBOX_TOKEN || "",

  service: {
    center: {
      lat: num("OTTO_SERVICE_CENTER_LAT", 40.7128),
      lng: num("OTTO_SERVICE_CENTER_LNG", -74.006),
    },
    radiusM: num("OTTO_SERVICE_RADIUS_M", 40000),
  },
  geocodeMinConfidence: num("OTTO_GEOCODE_MIN_CONFIDENCE", 0.5),

  twilio: {
    sid: process.env.TWILIO_ACCOUNT_SID || "",
    token: process.env.TWILIO_AUTH_TOKEN || "",
    from: process.env.TWILIO_FROM || "",
  },
  sendgrid: {
    key: process.env.SENDGRID_API_KEY || "",
    from: process.env.SENDGRID_FROM || "",
  },
  stripeKey: process.env.STRIPE_SECRET_KEY || "",
};

export function requireMapboxToken(): string {
  if (!config.mapboxToken) {
    throw new Error(
      "MAPBOX_TOKEN is not set. Map tools (geocode/routing/traffic) need it. Copy .env.example to .env and add your token."
    );
  }
  return config.mapboxToken;
}
