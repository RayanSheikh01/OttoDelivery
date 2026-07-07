import { config } from "../config.js";
import { ToolError } from "../errors.js";

const BASE = "https://api.stripe.com/v1";

export const stripeEnabled = () => config.stripeKey.length > 0;

/**
 * Minimal Stripe REST call using fetch (no SDK dependency). Passes an
 * Idempotency-Key header so a repeated key returns the original result.
 */
async function post(
  path: string,
  form: Record<string, string>,
  idempotencyKey?: string
): Promise<any> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.stripeKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(form).toString(),
    });
  } catch (e) {
    throw new ToolError("provider_error", `Network error calling Stripe: ${(e as Error).message}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message ?? `Stripe ${res.status}`;
    if (res.status === 429) throw new ToolError("rate_limited", msg);
    throw new ToolError("invalid_input", msg, data?.error);
  }
  return data;
}

export async function createCharge(args: {
  amount: number; // major units, e.g. 12.50
  currency: string;
  idempotencyKey: string;
  orderId: string;
}) {
  // Stripe wants the smallest currency unit (cents).
  const minor = Math.round(args.amount * 100);
  const data = await post(
    "/payment_intents",
    {
      amount: String(minor),
      currency: args.currency.toLowerCase(),
      confirm: "true",
      "payment_method_types[]": "card",
      payment_method: "pm_card_visa", // test token; swap for a real PM in prod
      "metadata[order_id]": args.orderId,
    },
    args.idempotencyKey
  );
  return { transaction_id: data.id as string, status: data.status as string, raw: data };
}

export async function createRefund(args: {
  chargeOrIntentId: string;
  amount?: number;
  reason?: string;
  idempotencyKey?: string;
}) {
  const form: Record<string, string> = { payment_intent: args.chargeOrIntentId };
  if (args.amount !== undefined) form.amount = String(Math.round(args.amount * 100));
  const data = await post("/refunds", form, args.idempotencyKey);
  return { refund_id: data.id as string, status: data.status as string, raw: data };
}
