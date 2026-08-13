import type { Env, RawReport } from "../types";
import { hmacHex, timingSafeEqualHex } from "./verify";

/**
 * Kapso proxies the Meta WhatsApp Cloud API. Inbound webhook: X-Webhook-Signature
 * is hex HMAC-SHA256 of the raw body. Payload carries `message` (or `messages`)
 * in Cloud API shape: { id, from, text: { body }, interactive: { button_reply } }.
 */
export async function verifyKapso(env: Env, body: string, signature: string | null): Promise<boolean> {
  if (!env.KAPSO_WEBHOOK_SECRET) return false; // trust boundary: unset secret = reject
  if (!signature) return false;
  const expected = await hmacHex(env.KAPSO_WEBHOOK_SECRET, body);
  return timingSafeEqualHex(expected, signature);
}

interface CloudApiMessage {
  id: string;
  from: string;
  text?: { body?: string };
  interactive?: { button_reply?: { id: string; title: string } };
}

export function parseKapso(payload: any): RawReport[] {
  const msgs: CloudApiMessage[] = payload?.messages ?? (payload?.message ? [payload.message] : []);
  return msgs
    .filter((m) => m?.id && m?.from)
    .map((m) => ({
      channel: "whatsapp" as const,
      providerId: m.id,
      sender: m.from,
      text: m.text?.body ?? m.interactive?.button_reply?.title ?? "",
      buttonId: m.interactive?.button_reply?.id,
    }));
}

const KAPSO_BASE = "https://api.kapso.ai/meta/whatsapp/v24.0";

async function kapsoSend(env: Env, body: unknown): Promise<void> {
  if (!env.KAPSO_API_KEY || !env.KAPSO_PHONE_ID) return;
  await fetch(`${KAPSO_BASE}/${env.KAPSO_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": env.KAPSO_API_KEY },
    body: JSON.stringify(body),
  });
}

export function sendText(env: Env, to: string, text: string): Promise<void> {
  return kapsoSend(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  });
}

export function sendConfirmButtons(env: Env, to: string, text: string): Promise<void> {
  return kapsoSend(env, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text },
      action: {
        buttons: [
          { type: "reply", reply: { id: "btn_sumar", title: "Sí, sumarme" } },
          { type: "reply", reply: { id: "btn_nueva", title: "Nueva solicitud" } },
        ],
      },
    },
  });
}
