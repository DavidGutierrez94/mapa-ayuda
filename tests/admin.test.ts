import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const call = (path: string, token: string, body?: object) =>
  SELF.fetch(`https://x${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body && { body: JSON.stringify(body) }),
  });

const seedRequest = () =>
  env.DB.prepare(
    "INSERT INTO requests (need_type, urgency, channel, muni_code, muni_name) VALUES ('agua', 2, 'web', '27001', 'Quibdó')",
  ).run();

beforeEach(async () => {
  await env.DB.exec("DELETE FROM mod_log; DELETE FROM users; DELETE FROM confirmations; DELETE FROM requests;");
});

describe("roles + audit log (PRD v2 P1)", () => {
  it("admin creates users; each token gets exactly its role's access", async () => {
    const mkRes = await call("/api/admin/users", "test-admin-token", { name: "María", role: "mod" });
    expect(mkRes.status).toBe(201);
    const { token: modToken } = (await mkRes.json()) as any;
    const { token: respToken } = (await (
      await call("/api/admin/users", "test-admin-token", { name: "Cruz Roja Chocó", role: "responder" })
    ).json()) as any;

    // mod token: can moderate, cannot administer
    expect((await call("/api/mod/queue", modToken)).status).toBe(200);
    expect((await call("/api/admin/users", modToken)).status).toBe(403);

    // responder token: can see responder view, cannot moderate
    expect((await call("/api/responder/requests", respToken)).status).toBe(200);
    expect((await call("/api/mod/queue", respToken)).status).toBe(403);

    // garbage token: nothing
    expect((await call("/api/mod/queue", "nope")).status).toBe(401);
  });

  it("every moderation action writes an audit row with actor and role", async () => {
    await seedRequest();
    const { token: modToken } = (await (
      await call("/api/admin/users", "test-admin-token", { name: "María", role: "mod" })
    ).json()) as any;
    const [req] = (await (await call("/api/mod/requests?status=pending", modToken)).json()) as any[];

    await call("/api/mod/action", modToken, { id: req.id, action: "verify" });
    await call("/api/mod/action", modToken, { id: req.id, action: "update", urgency: 1 });
    await call("/api/responder/action", "test-responder-token", { id: req.id, action: "attend" });

    const log = (await (await call("/api/admin/log", "test-admin-token")).json()) as any[];
    const actions = log.map((l: any) => `${l.actor}:${l.role}:${l.action}`);
    expect(actions).toContain("María:mod:verify");
    expect(actions).toContain("María:mod:update");
    expect(actions).toContain("legacy-responder:responder:attend");
    expect(actions).toContain("admin-bootstrap:admin:user_create");
    expect(log.find((l: any) => l.action === "verify").request_id).toBe(req.id);
  });

  it("revoked user loses access immediately and the revocation is logged", async () => {
    const { id, token } = (await (
      await call("/api/admin/users", "test-admin-token", { name: "Temporal", role: "mod" })
    ).json()) as any;
    expect((await call("/api/mod/queue", token)).status).toBe(200);
    await call("/api/admin/users/revoke", "test-admin-token", { id });
    expect((await call("/api/mod/queue", token)).status).toBe(401);
    const log = (await (await call("/api/admin/log", "test-admin-token")).json()) as any[];
    expect(log.some((l: any) => l.action === "user_revoke")).toBe(true);
  });

  it("legacy env tokens still work and are identified in the log", async () => {
    await seedRequest();
    const [req] = (await (await call("/api/mod/requests?status=pending", "test-mod-token")).json()) as any[];
    await call("/api/mod/action", "test-mod-token", { id: req.id, action: "verify" });
    const log = (await (await call("/api/admin/log?actor=legacy", "test-admin-token")).json()) as any[];
    expect(log[0]).toMatchObject({ actor: "legacy-mod", role: "mod", action: "verify" });
  });
});
