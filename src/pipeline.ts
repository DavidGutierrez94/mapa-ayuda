import type { Env, PipelineReply, RawReport, TriagedReport } from "./types";
import { llmTriage } from "./triage";
import { byCode, byName, findInText, type Muni } from "./gazetteer";

/** Store raw message; false = duplicate webhook delivery (already processed). */
export async function storeRaw(env: Env, r: RawReport): Promise<boolean> {
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO raw_messages (channel, provider_msg_id, sender, body) VALUES (?,?,?,?)",
  )
    .bind(r.channel, r.providerId, r.sender, r.text)
    .run();
  return res.meta.changes > 0;
}

export interface NewRequest {
  need_type: string;
  urgency: number;
  description: string | null;
  muni: Muni | null;
  location_raw: string | null;
  location_detail: string | null;
  households: number;
  contact: string | null;
  channel: string;
  source_org?: string | null;
  leader_id?: number | null;
  reporter_name?: string | null;
  people_count?: number | null;
  vulnerable?: string | null; // JSON array of group keys
  access_note?: string | null;
  precise_lat?: number | null; // PRIVATE: exact GPS from the reporter's device
  precise_lon?: number | null;
  ip_city?: string | null; // PRIVATE: Cloudflare-geolocated city, moderation signal only
  ip_match?: number | null; // 1 = IP city matches claimed muni, 0 = mismatch, null = unknown
  quantity?: string | null; // free text: "20 mercados"
}

export async function createRequest(env: Env, r: NewRequest): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO requests
     (need_type, urgency, description, muni_code, muni_name, dept, lat, lon,
      location_raw, location_detail, households, contact, channel, source_org, leader_id,
      reporter_name, people_count, vulnerable, access_note, precise_lat, precise_lon, ip_city, ip_match, quantity)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      r.need_type,
      r.urgency,
      r.description,
      r.muni?.code ?? null,
      r.muni?.name ?? null,
      r.muni?.dept ?? null,
      r.muni?.lat ?? null,
      r.muni?.lon ?? null,
      r.location_raw,
      r.location_detail,
      r.households,
      r.contact,
      r.channel,
      r.source_org ?? null,
      r.leader_id ?? null,
      r.reporter_name ?? null,
      r.people_count ?? null,
      r.vulnerable ?? null,
      r.access_note ?? null,
      r.precise_lat ?? null,
      r.precise_lon ?? null,
      r.ip_city ?? null,
      r.ip_match ?? null,
      r.quantity ?? null,
    )
    .run();
  return res.meta.last_row_id as number;
}

/** One confirmation per phone per request — UNIQUE constraint does the gating. */
export async function confirm(env: Env, requestId: number, phone: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO confirmations (request_id, phone) VALUES (?,?)",
  )
    .bind(requestId, phone)
    .run();
  return res.meta.changes > 0;
}

async function findDuplicate(env: Env, muniCode: string, needType: string) {
  return env.DB.prepare(
    `SELECT id, muni_name, need_type FROM requests
     WHERE muni_code = ? AND need_type = ? AND status IN ('pending','verified','attending')
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(muniCode, needType)
    .first<{ id: number; muni_name: string; need_type: string }>();
}

const NEED_LABEL: Record<string, string> = {
  agua: "agua",
  alimentos: "alimentos",
  medico: "atención médica",
  rescate: "rescate",
  techo: "techo/albergue",
  higiene: "kits de higiene y aseo",
  infancia: "artículos para niños y bebés",
  otro: "ayuda",
};

/**
 * Handle an inbound chat message (WhatsApp or SMS): conversation state first
 * (pending "¿quieres sumarte?"), otherwise triage as a new report.
 */
export async function handleInbound(env: Env, r: RawReport): Promise<PipelineReply> {
  const isNew = await storeRaw(env, r);
  if (!isNew) return { kind: "none", text: "" };

  const pending = await env.DB.prepare(
    "SELECT request_id, payload FROM pending_actions WHERE phone = ?",
  )
    .bind(r.sender)
    .first<{ request_id: number; payload: string | null }>();

  if (pending) {
    await env.DB.prepare("DELETE FROM pending_actions WHERE phone = ?").bind(r.sender).run();
    const saidYes =
      r.buttonId === "btn_sumar" || /^\s*s[ií]\b/i.test(r.text ?? "");
    if (saidYes) {
      const added = await confirm(env, pending.request_id, r.sender);
      return {
        kind: "confirmed",
        requestId: pending.request_id,
        text: added
          ? "✔ Listo, sumamos tu reporte a la solicitud existente. Los organismos de ayuda ven la necesidad con mayor prioridad."
          : "Ya habías confirmado esta solicitud. Gracias.",
      };
    }
    // "nueva solicitud" (button or any other reply): create from the saved payload.
    if (pending.payload) {
      const p = JSON.parse(pending.payload) as TriagedReport & { muni_code: string | null };
      const id = await createRequest(env, {
        need_type: p.need_type,
        urgency: p.urgency,
        description: p.description,
        muni: byCode(p.muni_code),
        location_raw: p.location_raw,
        location_detail: null,
        households: p.households,
        contact: r.sender,
        channel: r.channel,
        quantity: p.quantity ?? null,
      });
      return {
        kind: "created",
        requestId: id,
        text: `✔ Registramos tu solicitud (#${id}). Un moderador la verificará y aparecerá en el mapa público. Si la situación cambia, escríbenos de nuevo.`,
      };
    }
    // No payload (edge: state row without payload) — fall through to fresh triage.
  }

  const t = await llmTriage(env, r.text);
  const muni = findInText(t.location_raw) ?? findInText(r.text);

  if (muni) {
    const dup = await findDuplicate(env, muni.code, t.need_type);
    if (dup) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO pending_actions (phone, request_id, payload) VALUES (?,?,?)",
      )
        .bind(r.sender, dup.id, JSON.stringify({ ...t, muni_code: muni.code }))
        .run();
      return {
        kind: "ask_confirm",
        requestId: dup.id,
        text: `Ya hay una solicitud de ${NEED_LABEL[dup.need_type]} para ${dup.muni_name}. ¿Quieres sumarte a esa solicitud? Cada persona que se suma le da más prioridad.`,
      };
    }
  }

  const id = await createRequest(env, {
    need_type: t.need_type,
    urgency: t.urgency,
    description: t.description,
    muni,
    location_raw: t.location_raw,
    location_detail: null,
    households: t.households,
    contact: r.sender,
    channel: r.channel,
    quantity: t.quantity ?? null,
  });
  return {
    kind: "created",
    requestId: id,
    text:
      `✔ Registramos tu solicitud (#${id})` +
      (muni ? ` en ${muni.name}` : "") +
      ". Un moderador la verificará. Si reportas por varias familias o veredas, puedes enviar un mensaje por cada necesidad.",
  };
}
