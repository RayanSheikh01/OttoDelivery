import { config } from "../config.js";
import { ToolError } from "../errors.js";

export type Channel = "sms" | "email" | "push";

export interface SendResult {
  provider_id: string;
  status: string; // "sent" | "queued" | "dry_run"
}

const twilioEnabled = () =>
  config.twilio.sid && config.twilio.token && config.twilio.from;
const sendgridEnabled = () => config.sendgrid.key && config.sendgrid.from;

async function sendSms(to: string, body: string): Promise<SendResult> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilio.sid}/Messages.json`;
  const auth = Buffer.from(`${config.twilio.sid}:${config.twilio.token}`).toString("base64");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: config.twilio.from, Body: body }).toString(),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 429) throw new ToolError("rate_limited", data?.message ?? "Twilio 429");
    throw new ToolError("invalid_input", data?.message ?? `Twilio ${res.status}`, data);
  }
  return { provider_id: data.sid, status: data.status ?? "queued" };
}

async function sendEmail(to: string, body: string): Promise<SendResult> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sendgrid.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.sendgrid.from },
      subject: "Your OttoDelivery order",
      content: [{ type: "text/plain", value: body }],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 429) throw new ToolError("rate_limited", txt);
    throw new ToolError("invalid_input", `SendGrid ${res.status}: ${txt}`);
  }
  return { provider_id: res.headers.get("x-message-id") ?? "sendgrid", status: "queued" };
}

/**
 * Side-effecting: reaches a real person. Falls back to DRY-RUN (no send, just
 * a logged record) when the channel's provider creds are absent, so nothing
 * fires by accident in a fresh checkout.
 */
export async function send(channel: Channel, to: string, body: string): Promise<SendResult> {
  if (channel === "sms") {
    if (!twilioEnabled()) return { provider_id: `dry-${Date.now()}`, status: "dry_run" };
    return sendSms(to, body);
  }
  if (channel === "email") {
    if (!sendgridEnabled()) return { provider_id: `dry-${Date.now()}`, status: "dry_run" };
    return sendEmail(to, body);
  }
  // push: no provider wired; always dry-run for now.
  return { provider_id: `dry-${Date.now()}`, status: "dry_run" };
}
