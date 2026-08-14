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
