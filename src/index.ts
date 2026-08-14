import type { Env, PipelineReply } from "./types";
import { handleInbound, createRequest, storeRaw } from "./pipeline";
import { byCode, byName, allMunis } from "./gazetteer";
import { resolveActor, logAction, sha256hex, RANK, type Actor } from "./auth";
import * as kapso from "./adapters/kapso";
import * as smsgate from "./adapters/smsgate";

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", ...headers },
  });

const bearer = (req: Request) =>
  req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;

const NEED_TYPES = ["agua", "alimentos", "medico", "rescate", "techo", "otro"];
const PUBLIC_STATUSES = ["verified", "attending", "resolved"];

/** Hand-rolled mirror of schema/help-request.schema.json (v1). Returns error list. */
export function validateHelpRequest(b: any): string[] {
  const errs: string[] = [];
  if (typeof b !== "object" || b === null) return ["body must be a JSON object"];
  const allowed = ["need_type", "urgency", "description", "location", "households", "contact", "reported_at"];
  for (const k of Object.keys(b)) if (!allowed.includes(k)) errs.push(`unknown field: ${k}`);
  if (!NEED_TYPES.includes(b.need_type)) errs.push(`need_type must be one of ${NEED_TYPES.join("|")}`);
  if (b.urgency !== undefined && ![1, 2, 3].includes(b.urgency)) errs.push("urgency must be 1, 2 or 3");
  if (typeof b.location !== "object" || b.location === null) errs.push("location is required");
  else {
    const loc = b.location;
    const lAllowed = ["muni_code", "muni_name", "detail", "raw"];
    for (const k of Object.keys(loc)) if (!lAllowed.includes(k)) errs.push(`unknown location field: ${k}`);
    if (!loc.muni_code && !loc.muni_name && !loc.raw)
      errs.push("location needs muni_code, muni_name or raw");
  }
  if (b.households !== undefined && (!Number.isInteger(b.households) || b.households < 1))
    errs.push("households must be a positive integer");
  return errs;
}

async function verifyTurnstile(env: Env, token: string | undefined, ip: string | null): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true; // dev/local: not configured → open (set the secret in prod!)
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip ?? undefined }),
  });
  return res.ok && ((await res.json()) as any).success === true;
}

function orgForToken(env: Env, token: string | null): string | null {
  if (!token || !env.ORG_TOKENS) return null;
  for (const pair of env.ORG_TOKENS.split(",")) {
    const [name, t] = pair.split(":").map((s) => s.trim());
    if (t && t === token) return name;
  }
  return null;
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Webhooks ──
    if (request.method === "POST" && path === "/webhook/kapso") {
      const body = await request.text();
      if (!(await kapso.verifyKapso(env, body, request.headers.get("X-Webhook-Signature"))))
        return json({ error: "invalid signature" }, 401);
      const reports = kapso.parseKapso(JSON.parse(body));
      ctx.waitUntil(
        // ponytail: inline processing via waitUntil; move to Cloudflare Queues if volume demands
        (async () => {
          for (const r of reports) {
            const reply: PipelineReply = await handleInbound(env, r);
            if (reply.kind === "ask_confirm") await kapso.sendConfirmButtons(env, r.sender, reply.text);
            else if (reply.kind !== "none") await kapso.sendText(env, r.sender, reply.text);
          }
        })(),
      );
      return json({ ok: true });
    }

    if (request.method === "POST" && path === "/webhook/smsgate") {
      const body = await request.text();
      const ok = await smsgate.verifySmsgate(
        env,
        body,
        request.headers.get("X-Signature"),
        request.headers.get("X-Timestamp"),
      );
      if (!ok) return json({ error: "invalid signature" }, 401);
      const report = smsgate.parseSmsgate(JSON.parse(body));
      if (report) {
        ctx.waitUntil(
          (async () => {
            const reply = await handleInbound(env, report);
            if (reply.kind === "ask_confirm")
              await smsgate.sendSms(env, report.sender, reply.text + " Responde SI para sumarte, o describe tu solicitud de nuevo.");
            else if (reply.kind !== "none") await smsgate.sendSms(env, report.sender, reply.text);
          })(),
        );
      }
      return json({ ok: true });
    }

    // ── Web form intake ──
    if (request.method === "POST" && path === "/api/web-intake") {
      const b = (await request.json().catch(() => null)) as any;
      if (!b) return json({ error: "invalid JSON" }, 400);
      if (!(await verifyTurnstile(env, b.turnstile_token, request.headers.get("CF-Connecting-IP"))))
        return json({ error: "verificación anti-spam fallida" }, 403);
      // Trusted leader lane (hybrid: open intake stays open; a valid leader link + cédula adds a verified badge).
      let leaderId: number | null = null;
      if (b.leader_token) {
        const leader = await env.DB.prepare("SELECT id, cedula_hash FROM leaders WHERE link_token = ? AND active = 1")
          .bind(String(b.leader_token))
          .first<any>();
        const cedula = String(b.cedula ?? "").replace(/\D/g, "");
        if (!leader || !cedula || (await sha256hex(cedula)) !== leader.cedula_hash)
          return json({ error: "verificación de líder fallida: revise el enlace y la cédula" }, 403);
        leaderId = leader.id;
      }
      // One submission may carry several needs (need_types[]); each becomes its own request
      // so the map keeps aggregating by (municipality, need). Fan-out is server-side because
      // a Turnstile token verifies only once.
      const needs = [
        ...new Set(((Array.isArray(b.need_types) ? b.need_types : [b.need_type]) as unknown[]).filter((n) => NEED_TYPES.includes(n as string))),
      ] as string[];
      if (!needs.length) return json({ error: "need_type inválido" }, 422);
      const muni = byCode(b.muni_code) ?? byName(b.muni_name);
      const ids: number[] = [];
      for (const need_type of needs)
        ids.push(
          await createRequest(env, {
            need_type,
            urgency: [1, 2, 3].includes(b.urgency) ? b.urgency : 2,
            description: b.description ? String(b.description).slice(0, 2000) : null,
            muni,
            location_raw: b.muni_name ?? null,
            location_detail: b.detail ? String(b.detail).slice(0, 500) : null,
            households: Number.isInteger(b.households) && b.households > 0 ? b.households : 1,
            contact: b.contact ? String(b.contact).slice(0, 50) : null,
            channel: "web",
            leader_id: leaderId,
          }),
        );
      return json({ ok: true, id: ids[0], ids }, 201);
    }

    // Public: validate a leader link before showing the leader section on the form.
    if (request.method === "GET" && path === "/api/leader-check") {
      const row = await env.DB.prepare("SELECT name FROM leaders WHERE link_token = ? AND active = 1")
        .bind(url.searchParams.get("token") ?? "")
        .first<any>();
      return json(row ? { ok: true, name: row.name } : { ok: false });
    }

    // ── Open intake standard: org push ──
    if (request.method === "POST" && path === "/api/requests") {
      const org = orgForToken(env, bearer(request));
      if (!org) return json({ error: "unauthorized" }, 401);
      const b = (await request.json().catch(() => null)) as any;
      if (!b) return json({ error: "invalid JSON" }, 400);
      const errs = validateHelpRequest(b);
      if (errs.length) return json({ error: "schema validation failed", details: errs }, 422);
      const muni = byCode(b.location.muni_code) ?? byName(b.location.muni_name) ?? byName(b.location.raw);
      // provider id = org + hash of body → idempotent re-pushes
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(b)));
      const hash = [...new Uint8Array(digest)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
      const fresh = await storeRaw(env, { channel: "sms", providerId: `${org}:${hash}`, sender: org, text: "" } as any);
      if (!fresh) return json({ ok: true, duplicate: true }, 200);
      const id = await createRequest(env, {
        need_type: b.need_type,
        urgency: b.urgency ?? 2,
        description: b.description ?? null,
        muni,
        location_raw: b.location.raw ?? b.location.muni_name ?? null,
        location_detail: b.location.detail ?? null,
        households: b.households ?? 1,
        contact: b.contact ?? null,
        channel: "api",
        source_org: org,
      });
      return json({ ok: true, id }, 201);
    }

    // ── Public aggregated feed (zero PII) ──
    if (request.method === "GET" && path === "/api/feed") {
      const statuses = (url.searchParams.get("status")?.split(",") ?? ["verified", "attending"]).filter((s) =>
        PUBLIC_STATUSES.includes(s),
      );
      const need = url.searchParams.get("need");
      const rows = (
        await env.DB.prepare(
          `SELECT r.muni_code, r.muni_name, r.dept, r.lat, r.lon, r.need_type, r.status,
                  COUNT(*) AS requests,
                  SUM(r.households) AS households,
                  COUNT(*) + IFNULL(SUM(c.cnt), 0) AS reportes,
                  MAX(r.urgency = 1) AS has_critical
           FROM requests r
           LEFT JOIN (SELECT request_id, COUNT(*) cnt FROM confirmations GROUP BY request_id) c
             ON c.request_id = r.id
           WHERE r.status IN (${statuses.map(() => "?").join(",") || "''"})
             ${need ? "AND r.need_type = ?" : ""}
           GROUP BY r.muni_code, r.need_type, r.status`,
        )
          .bind(...statuses, ...(need ? [need] : []))
          .all()
      ).results;

      const format = url.searchParams.get("format") ?? "json";
      if (format === "csv") {
        const cols = ["muni_code", "muni_name", "dept", "lat", "lon", "need_type", "status", "requests", "households", "reportes"];
        const csv = [cols.join(","), ...rows.map((r: any) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": "attachment; filename=mapa-ayuda-feed.csv",
            "access-control-allow-origin": "*",
          },
        });
      }
      if (format === "geojson") {
        return json({
          type: "FeatureCollection",
          features: rows
            .filter((r: any) => r.lat != null)
            .map((r: any) => ({
              type: "Feature",
              geometry: { type: "Point", coordinates: [r.lon, r.lat] },
              properties: { ...r, lat: undefined, lon: undefined },
            })),
        });
      }
      return json({ generated_at: new Date().toISOString(), rows });
    }

    // ── Municipality list for the searchable pickers ──
    if (request.method === "GET" && path === "/api/municipios") {
      return json(allMunis(), 200, { "cache-control": "public, max-age=3600" });
    }

    // ── Config for static pages ──
    if (request.method === "GET" && path === "/api/config") {
      return json({ turnstile_sitekey: env.TURNSTILE_SITEKEY ?? null });
    }

    // ── Admin: users + audit log ──
    if (path.startsWith("/api/admin/")) {
      const actor = await resolveActor(env, bearer(request));
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (RANK[actor.role] < RANK.admin) return json({ error: "forbidden" }, 403);
      if (request.method === "GET" && path === "/api/admin/users") {
        const rows = await env.DB.prepare(
          "SELECT id, name, role, active, created_by, created_at FROM users ORDER BY id DESC",
        ).all();
        return json(rows.results);
      }
      if (request.method === "POST" && path === "/api/admin/users") {
        const b = (await request.json().catch(() => null)) as any;
        if (!b?.name || !["admin", "mod", "responder"].includes(b.role))
          return json({ error: "name and role (admin|mod|responder) required" }, 422);
        const token = `${b.role}_${crypto.randomUUID().replace(/-/g, "")}`;
        const res = await env.DB.prepare("INSERT INTO users (name, role, token_hash, created_by) VALUES (?,?,?,?)")
          .bind(String(b.name).slice(0, 100), b.role, await sha256hex(token), actor.name)
          .run();
        await logAction(env, actor, "user_create", null, { user_id: res.meta.last_row_id, name: b.name, role: b.role });
        return json({ ok: true, id: res.meta.last_row_id, token }, 201); // token is shown exactly once
      }
      if (request.method === "POST" && path === "/api/admin/users/revoke") {
        const b = (await request.json().catch(() => null)) as any;
        if (!b?.id) return json({ error: "id required" }, 400);
        await env.DB.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(b.id).run();
        await logAction(env, actor, "user_revoke", null, { user_id: b.id });
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/api/admin/leaders") {
        const rows = await env.DB.prepare(
          "SELECT id, name, phone, muni_code, cedula_last3, link_token, active, created_by, created_at FROM leaders ORDER BY id DESC",
        ).all();
        return json(rows.results);
      }
      if (request.method === "POST" && path === "/api/admin/leaders") {
        const b = (await request.json().catch(() => null)) as any;
        if (!b?.name || !b?.cedula) return json({ error: "name and cedula required" }, 422);
        const cedula = String(b.cedula).replace(/\D/g, "");
        if (cedula.length < 5) return json({ error: "cedula inválida" }, 422);
        const link_token = `lider_${crypto.randomUUID().replace(/-/g, "")}`;
        const res = await env.DB.prepare(
          "INSERT INTO leaders (name, phone, muni_code, cedula_hash, cedula_last3, link_token, created_by) VALUES (?,?,?,?,?,?,?)",
        )
          .bind(
            String(b.name).slice(0, 100),
            b.phone ? String(b.phone).slice(0, 50) : null,
            byCode(b.muni_code)?.code ?? null,
            await sha256hex(cedula), // raw cédula is hashed and discarded (Ley 1581 minimization)
            cedula.slice(-3),
            link_token,
            actor.name,
          )
          .run();
        await logAction(env, actor, "leader_create", null, { leader_id: res.meta.last_row_id, name: b.name });
        return json({ ok: true, id: res.meta.last_row_id, link_token }, 201);
      }
      if (request.method === "POST" && path === "/api/admin/leaders/revoke") {
        const b = (await request.json().catch(() => null)) as any;
        if (!b?.id) return json({ error: "id required" }, 400);
        await env.DB.prepare("UPDATE leaders SET active = 0 WHERE id = ?").bind(b.id).run();
        await logAction(env, actor, "leader_revoke", null, { leader_id: b.id });
        return json({ ok: true });
      }
      if (request.method === "GET" && path === "/api/admin/log") {
        const conds: string[] = [];
        const binds: unknown[] = [];
        const rid = url.searchParams.get("request_id");
        if (rid) { conds.push("request_id = ?"); binds.push(+rid); }
        const who = url.searchParams.get("actor");
        if (who) { conds.push("actor LIKE ?"); binds.push(`%${who}%`); }
        const rows = await env.DB.prepare(
          `SELECT * FROM mod_log ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT 300`,
        ).bind(...binds).all();
        return json(rows.results);
      }
      return json({ error: "not found" }, 404);
    }

    // ── Moderation ──
    if (path.startsWith("/api/mod/")) {
      const actor = await resolveActor(env, bearer(request));
      if (!actor) return json({ error: "unauthorized" }, 401);
      if (RANK[actor.role] < RANK.mod) return json({ error: "forbidden" }, 403);
      if (request.method === "GET" && path === "/api/mod/queue") {
        const rows = await env.DB.prepare(
          `SELECT r.*, IFNULL(c.cnt,0) AS confirmations, l.name AS leader_name, l.cedula_last3 AS leader_cc FROM requests r
           LEFT JOIN (SELECT request_id, COUNT(*) cnt FROM confirmations GROUP BY request_id) c ON c.request_id = r.id
           LEFT JOIN leaders l ON l.id = r.leader_id
           WHERE r.status = 'pending' ORDER BY r.urgency, r.id DESC LIMIT 200`,
        ).all();
        return json(rows.results);
      }
      // Full listing for the dashboard: tabs (status), search (q) and filters (need, urgency).
      if (request.method === "GET" && path === "/api/mod/requests") {
        const conds = ["r.status = ?"];
        const binds: unknown[] = [url.searchParams.get("status") ?? "pending"];
        const need = url.searchParams.get("need");
        if (need) { conds.push("r.need_type = ?"); binds.push(need); }
        const urgency = url.searchParams.get("urgency");
        if (urgency) { conds.push("r.urgency = ?"); binds.push(+urgency); }
        const q = url.searchParams.get("q");
        if (q) {
          conds.push("(CAST(r.id AS TEXT) = ? OR r.description LIKE ? OR r.muni_name LIKE ? OR r.location_raw LIKE ? OR r.location_detail LIKE ? OR r.contact LIKE ?)");
          const like = `%${q}%`;
          binds.push(q, like, like, like, like, like);
        }
        const rows = await env.DB.prepare(
          `SELECT r.*, IFNULL(c.cnt,0) AS confirmations, l.name AS leader_name, l.cedula_last3 AS leader_cc FROM requests r
           LEFT JOIN (SELECT request_id, COUNT(*) cnt FROM confirmations GROUP BY request_id) c ON c.request_id = r.id
           LEFT JOIN leaders l ON l.id = r.leader_id
           WHERE ${conds.join(" AND ")} ORDER BY r.urgency, r.id DESC LIMIT 200`,
        ).bind(...binds).all();
        return json(rows.results);
      }
      // Manual intake (phone call, radio, in person). Lands as pending: the human gate applies to moderators' own entries too.
      if (request.method === "POST" && path === "/api/mod/create") {
        const b = (await request.json().catch(() => null)) as any;
        if (!b) return json({ error: "invalid JSON" }, 400);
        const needs = [
          ...new Set(((Array.isArray(b.need_types) ? b.need_types : [b.need_type]) as unknown[]).filter((n) => NEED_TYPES.includes(n as string))),
        ] as string[];
        if (!needs.length) return json({ error: "need_type inválido" }, 422);
        const muni = byCode(b.muni_code) ?? byName(b.muni_name);
        const ids: number[] = [];
        for (const need_type of needs)
          ids.push(
            await createRequest(env, {
              need_type,
              urgency: [1, 2, 3].includes(b.urgency) ? b.urgency : 2,
              description: b.description ? String(b.description).slice(0, 2000) : null,
              muni,
              location_raw: b.muni_name ?? null,
              location_detail: b.location_detail ? String(b.location_detail).slice(0, 500) : null,
              households: Number.isInteger(b.households) && b.households > 0 ? b.households : 1,
              contact: b.contact ? String(b.contact).slice(0, 50) : null,
              channel: "manual",
            }),
          );
        await logAction(env, actor, "create", ids[0], { ids, needs });
        return json({ ok: true, id: ids[0], ids }, 201);
      }
      if (request.method === "POST" && path === "/api/mod/action") {
        const b = (await request.json().catch(() => null)) as any;
        const actions: Record<string, string> = {
          verify: "verified",
          reject: "rejected",
          attend: "attending",
          resolve: "resolved",
        };
        if (!b?.id) return json({ error: "id required" }, 400);
        if (b.action === "delete") {
          // Hard delete, for spam/test entries; real cases should be rejected, not deleted.
          await env.DB.prepare("DELETE FROM confirmations WHERE request_id = ?").bind(b.id).run();
          await env.DB.prepare("DELETE FROM pending_actions WHERE request_id = ?").bind(b.id).run();
          await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(b.id).run();
          await logAction(env, actor, "delete", b.id);
          return json({ ok: true });
        }
        if (b.action === "merge") {
          if (!b.target_id) return json({ error: "target_id required" }, 400);
          const merged = await env.DB.prepare("SELECT contact FROM requests WHERE id = ?").bind(b.id).first<any>();
          await env.DB.prepare("UPDATE requests SET status='rejected', updated_at=datetime('now') WHERE id = ?").bind(b.id).run();
          await env.DB.prepare("INSERT OR IGNORE INTO confirmations (request_id, phone) VALUES (?,?)")
            .bind(b.target_id, merged?.contact ?? `merged:${b.id}`)
            .run();
          await logAction(env, actor, "merge", b.id, { target_id: b.target_id });
          return json({ ok: true });
        }
        // Moderator corrections (fix municipality / need type) ride along with any action.
        const muni = byCode(b.muni_code);
        if (muni)
          await env.DB.prepare(
            "UPDATE requests SET muni_code=?, muni_name=?, dept=?, lat=?, lon=? WHERE id = ?",
          )
            .bind(muni.code, muni.name, muni.dept, muni.lat, muni.lon, b.id)
            .run();
        if (b.action === "update") {
          const sets: string[] = [];
          const binds: unknown[] = [];
          if (NEED_TYPES.includes(b.need_type)) { sets.push("need_type=?"); binds.push(b.need_type); }
          if ([1, 2, 3].includes(b.urgency)) { sets.push("urgency=?"); binds.push(b.urgency); }
          if (typeof b.description === "string") { sets.push("description=?"); binds.push(b.description.slice(0, 2000) || null); }
          if (Number.isInteger(b.households) && b.households > 0) { sets.push("households=?"); binds.push(b.households); }
          if (typeof b.contact === "string") { sets.push("contact=?"); binds.push(b.contact.slice(0, 50) || null); }
          if (typeof b.location_detail === "string") { sets.push("location_detail=?"); binds.push(b.location_detail.slice(0, 500) || null); }
          if (sets.length)
            await env.DB.prepare(`UPDATE requests SET ${sets.join(",")}, updated_at=datetime('now') WHERE id = ?`)
              .bind(...binds, b.id)
              .run();
          await logAction(env, actor, "update", b.id, b);
          return json({ ok: true });
        }
        if (!actions[b.action]) return json({ error: "unknown action" }, 400);
        await env.DB.prepare("UPDATE requests SET status=?, updated_at=datetime('now') WHERE id = ?")
          .bind(actions[b.action], b.id)
          .run();
        await logAction(env, actor, b.action, b.id, muni ? { muni_code: muni.code } : undefined);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    }

    // ── Accredited responders: precise data ──
    if (request.method === "GET" && path === "/api/responder/requests") {
      const actor = await resolveActor(env, bearer(request));
      if (!actor) return json({ error: "unauthorized" }, 401);
      const rows = await env.DB.prepare(
        `SELECT r.*, IFNULL(c.cnt,0) AS confirmations, l.name AS leader_name, l.cedula_last3 AS leader_cc FROM requests r
         LEFT JOIN (SELECT request_id, COUNT(*) cnt FROM confirmations GROUP BY request_id) c ON c.request_id = r.id
         LEFT JOIN leaders l ON l.id = r.leader_id
         WHERE r.status IN ('verified','attending') ORDER BY r.urgency, r.id DESC`,
      ).all();
      return json(rows.results);
    }

    // Responders may move verified→attending→resolved, never verify/reject (human gate stays with moderators).
    if (request.method === "POST" && path === "/api/responder/action") {
      const actor = await resolveActor(env, bearer(request));
      if (!actor) return json({ error: "unauthorized" }, 401);
      const b = (await request.json().catch(() => null)) as any;
      const actions: Record<string, string> = { attend: "attending", resolve: "resolved" };
      if (!b?.id || !actions[b.action]) return json({ error: "id and action (attend|resolve) required" }, 400);
      await env.DB.prepare(
        "UPDATE requests SET status=?, updated_at=datetime('now') WHERE id = ? AND status IN ('verified','attending')",
      )
        .bind(actions[b.action], b.id)
        .run();
      await logAction(env, actor, b.action, b.id);
      return json({ ok: true });
    }

    // ── Static assets (map, form, moderation UI) ──
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
