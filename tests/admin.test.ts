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
  await env.DB.exec("DELETE FROM mod_log; DELETE FROM users; DELETE FROM leaders; DELETE FROM confirmations; DELETE FROM requests;");
});

const webIntake = (body: object) =>
  SELF.fetch("https://x/api/web-intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

describe("social leaders (PRD v2 P2)", () => {
  const mkLeader = async (name = "Doña Rosa", cedula = "1077998877") =>
    (await (
      await call("/api/admin/leaders", "test-admin-token", { name, cedula, muni_code: "27001" })
    ).json()) as any;

  it("valid link + cédula stamps the request; badge data visible to mod and responder, never public", async () => {
    const { link_token } = await mkLeader();
    const res = await webIntake({
      need_types: ["agua"], muni_name: "Quibdó", households: 20,
      leader_token: link_token, cedula: "1077998877", description: "reporte del barrio",
    });
    expect(res.status).toBe(201);

    const [req] = (await (await call("/api/mod/requests?status=pending", "test-mod-token")).json()) as any[];
    expect(req.leader_name).toBe("Doña Rosa");
    expect(req.leader_cc).toBe("877");

    await call("/api/mod/action", "test-mod-token", { id: req.id, action: "verify" });
    const resp = (await (await call("/api/responder/requests", "test-responder-token")).json()) as any[];
    expect(resp[0].leader_name).toBe("Doña Rosa");

    const feedText = await (await SELF.fetch("https://x/api/feed?status=verified")).text();
    expect(feedText).not.toContain("Rosa");
    expect(feedText).not.toContain("877");
  });

  it("wrong cédula or revoked leader → 403 and no request created", async () => {
    const { id, link_token } = await mkLeader("Don Pedro", "555444333");
    expect((await webIntake({ need_types: ["agua"], muni_name: "Quibdó", leader_token: link_token, cedula: "999" })).status).toBe(403);

    await call("/api/admin/leaders/revoke", "test-admin-token", { id });
    expect((await webIntake({ need_types: ["agua"], muni_name: "Quibdó", leader_token: link_token, cedula: "555444333" })).status).toBe(403);

    expect((await (await call("/api/mod/requests?status=pending", "test-mod-token")).json()) as any[]).toHaveLength(0);
    // plain submission without leader fields still works (hybrid lane)
    expect((await webIntake({ need_types: ["agua"], muni_name: "Quibdó" })).status).toBe(201);
  });

  it("raw cédula is never stored, only hash + last3", async () => {
    await mkLeader("Ana", "1234567890");
    const row = await env.DB.prepare("SELECT * FROM leaders").first<any>();
    expect(JSON.stringify(row)).not.toContain("1234567890");
    expect(row.cedula_last3).toBe("890");
    expect(row.cedula_hash).toHaveLength(64);
  });
});

describe("form v2 + geolocation (PRD v2 P3)", () => {
  it("v2 fields are stored, visible to mods/responders, and absent from public endpoints", async () => {
    const res = await webIntake({
      need_types: ["rescate"], muni_name: "Quibdó", households: 4, contact: "573001112233",
      reporter_name: "Carlos Mosquera", people_count: 18,
      vulnerable: ["ninos", "embarazadas", "hackers"], // unknown key must be filtered
      access_note: "vía bloqueada, solo en lancha",
      precise_lat: 5.12345, precise_lon: -76.54321, // distinct from the public muni centroid
    });
    expect(res.status).toBe(201);

    const [req] = (await (await call("/api/mod/requests?status=pending", "test-mod-token")).json()) as any[];
    expect(req).toMatchObject({
      reporter_name: "Carlos Mosquera", people_count: 18,
      access_note: "vía bloqueada, solo en lancha",
      precise_lat: 5.12345, precise_lon: -76.54321,
    });
    expect(JSON.parse(req.vulnerable)).toEqual(["ninos", "embarazadas"]);

    await call("/api/mod/action", "test-mod-token", { id: req.id, action: "verify" });
    const feedJson = await (await SELF.fetch("https://x/api/feed?status=verified")).text();
    const feedCsv = await (await SELF.fetch("https://x/api/feed?status=verified&format=csv")).text();
    for (const leak of ["Carlos", "5.12345", "-76.54321", "lancha"]) {
      expect(feedJson).not.toContain(leak);
      expect(feedCsv).not.toContain(leak);
    }
    const resp = (await (await call("/api/responder/requests", "test-responder-token")).json()) as any[];
    expect(resp[0].precise_lat).toBe(5.12345);
  });

  it("garbage coordinates are dropped, not stored", async () => {
    await webIntake({ need_types: ["agua"], muni_name: "Quibdó", precise_lat: 999, precise_lon: -76.6 });
    const [req] = (await (await call("/api/mod/requests?status=pending", "test-mod-token")).json()) as any[];
    expect(req.precise_lat).toBeNull();
    expect(req.precise_lon).toBeNull();
  });
});
