/**
 * Upstream error taxonomy the map tools surface, so agents can tell
 * "try again" (retriable) from "this can't be delivered" (terminal).
 */
export type UpstreamCode =
  | "rate_limited" // 429 — back off and retry
  | "no_route" // routing found no path — terminal for this pair
  | "address_ambiguous" // multiple/low-confidence matches — needs clarification
  | "address_unparseable" // could not parse at all — terminal
  | "out_of_range" // parsed & located but outside service area — terminal
  | "provider_error" // upstream 5xx / network — retriable
  | "not_found" // order/vehicle unknown — terminal
  | "invalid_input"; // caller error — terminal

const RETRIABLE = new Set<UpstreamCode>([
  "rate_limited",
  "provider_error",
]);

export class ToolError extends Error {
  code: UpstreamCode;
  retriable: boolean;
  details?: unknown;

  constructor(code: UpstreamCode, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retriable = RETRIABLE.has(code);
    this.details = details;
  }

  toPayload() {
    return {
      error: this.message,
      code: this.code,
      retriable: this.retriable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** Map a fetch Response status to a ToolError for map providers. */
export function fromHttp(status: number, body: string): ToolError {
  if (status === 429)
    return new ToolError("rate_limited", `Provider rate-limited (429): ${body}`);
  if (status >= 500)
    return new ToolError("provider_error", `Provider ${status}: ${body}`);
  if (status === 401 || status === 403)
    return new ToolError(
      "provider_error",
      `Provider auth failed (${status}). Check MAPBOX_TOKEN.`
    );
  return new ToolError("invalid_input", `Provider ${status}: ${body}`);
}
