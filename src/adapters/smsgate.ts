import type { Env, RawReport } from "../types";
import { hmacHex, timingSafeEqualHex } from "./verify";

/**
 * SMSGate (capcom6/android-sms-gateway) webhook for sms:received.
 * X-Signature = hex HMAC-SHA256(rawBody + X-Timestamp) with the signing key.
 */
export async function verifySmsgate(
  env: Env,
  body: string,
  signature: string | null,
  timestamp: string | null,
): Promise<boolean> {
  if (!env.SMSGATE_SIGNING_KEY) return false; // trust boundary: unset secret = reject
  if (!signature || !timestamp) return false;
  const expected = await hmacHex(env.SMSGATE_SIGNING_KEY, body + timestamp);
  return timingSafeEqualHex(expected, signature);
}

export function parseSmsgate(payload: any): RawReport | null {
  if (payload?.event !== "sms:received") return null;
  const p = payload.payload;
  if (!p?.messageId || !p?.sender) return null;
  return {
    channel: "sms",
    providerId: p.messageId,
    sender: p.sender,
    text: p.message ?? "",
  };
}

/** Reply via SMSGate cloud API (basic auth). No-op if creds unset. */
export async function sendSms(env: Env, to: string, text: string): Promise<void> {
  if (!env.SMSGATE_LOGIN || !env.SMSGATE_PASSWORD) return;
  await fetch("https://api.sms-gate.app/3rdparty/v1/message", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + btoa(`${env.SMSGATE_LOGIN}:${env.SMSGATE_PASSWORD}`),
    },
    body: JSON.stringify({ message: text, phoneNumbers: [to] }),
  });
}
