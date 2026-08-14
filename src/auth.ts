import type { Env } from "./types";

export interface Actor {
  name: string;
  role: "admin" | "mod" | "responder";
}

export const RANK: Record<Actor["role"], number> = { admin: 3, mod: 2, responder: 1 };

export async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cédula → HMAC-SHA256 keyed by a server-side pepper (H-3). Unlike a bare SHA-256,
 * an attacker who steals the DB cannot brute-force the ~10^10 cédula keyspace without
 * also stealing CEDULA_PEPPER (a Workers secret, not in the DB). Set it in prod:
 *   npx wrangler secret put CEDULA_PEPPER
 * Rotating the pepper invalidates existing hashes — leaders must be re-registered.
 */
export async function hashCedula(env: Env, cedula: string): Promise<string> {
  // Fail closed: an empty pepper would reduce this back to a brute-forceable keyed
  // hash an attacker could reproduce. Refuse to hash rather than store a weak digest.
  if (!env.CEDULA_PEPPER) throw new Error("CEDULA_PEPPER is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.CEDULA_PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(cedula));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fixed-window per-key rate limit backed by D1 (H-2). Returns true if the call is
 * allowed, false once the key has used `limit` calls in the current `windowSec` window.
 *
 * Done in ONE atomic upsert so concurrent requests can't race a read-modify-write and
 * over-admit near the boundary: the ON CONFLICT branch resets the counter when the row's
 * window has rolled over, otherwise increments it, and RETURNING gives us the resulting
 * count to compare against the limit. Stale rows for now-idle keys are swept by
 * cleanupRateLimits() on a cron so the table stays bounded and IP-derived keys aren't
 * retained indefinitely.
 */
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (k, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < ?2 THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < ?2 THEN ?2 ELSE rate_limits.window_start END
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

/** Sweep rate-limit rows whose window closed more than `olderThanSec` ago (cron cleanup). */
export async function cleanupRateLimits(env: Env, olderThanSec = 3600): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - olderThanSec;
  await env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff).run();
}

/** Bearer token → actor. Named users first; legacy env tokens keep working during migration. */
export async function resolveActor(env: Env, token: string | null): Promise<Actor | null> {
  if (!token) return null;
  const row = await env.DB.prepare("SELECT name, role FROM users WHERE token_hash = ? AND active = 1")
    .bind(await sha256hex(token))
    .first<Actor>();
  if (row) return row;
  if (env.ADMIN_TOKEN && token === env.ADMIN_TOKEN) return { name: "admin-bootstrap", role: "admin" };
  if (env.MOD_TOKEN && token === env.MOD_TOKEN) return { name: "legacy-mod", role: "mod" };
  if (env.RESPONDER_TOKEN && token === env.RESPONDER_TOKEN) return { name: "legacy-responder", role: "responder" };
  return null;
}

export async function logAction(
  env: Env,
  actor: Actor,
  action: string,
  requestId: number | null,
  detail?: unknown,
): Promise<void> {
  await env.DB.prepare("INSERT INTO mod_log (actor, role, action, request_id, detail) VALUES (?,?,?,?,?)")
    .bind(actor.name, actor.role, action, requestId, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
