import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashCedula, sha256hex } from "../src/auth";

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
  await env.DB.exec("DELETE FROM mod_log; DELETE FROM users; DELETE FROM leaders; DELETE FROM confirmations; DELETE FROM requests; DELETE FROM rate_limits;");
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

describe("security hardening", () => {
  const ipIntake = (ip: string, body: object = { need_types: ["agua"], muni_name: "Quibdó" }) =>
    SELF.fetch("https://x/api/web-intake", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify(body),
    });

  it("H-2: web intake is rate-limited per IP (429 past the window cap)", async () => {
    // A unique IP gives this test its own bucket; the limit is 20/min.
    const ip = "203.0.113.7";
    for (let i = 0; i < 20; i++) expect((await ipIntake(ip)).status).toBe(201);
    expect((await ipIntake(ip)).status).toBe(429);
    // A different IP is unaffected.
    expect((await ipIntake("203.0.113.8")).status).toBe(201);
  });

  it("H-2: the limit holds under a concurrent burst (atomic upsert, no over-admit)", async () => {
    const ip = "203.0.113.99";
    const results = await Promise.all(Array.from({ length: 25 }, () => ipIntake(ip)));
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(20); // exactly the limit even when 25 fire at once; the rest are 429
  });

  it("H-4: leader-check returns only validity, no identity at all", async () => {
    const { link_token } = (await (
      await call("/api/admin/leaders", "test-admin-token", { name: "Rosa Elena Palacios", cedula: "1077998877", muni_code: "27001" })
    ).json()) as any;
    const check = async (ip: string) =>
      SELF.fetch("https://x/api/leader-check?token=" + link_token, { headers: { "CF-Connecting-IP": ip } });
    const body = (await (await check("198.51.100.1")).json()) as any;
    expect(body).toEqual({ ok: true }); // no name, no greeting, nothing that could identify the leader
    expect(JSON.stringify(body)).not.toContain("Rosa");

    const ip = "198.51.100.2";
    for (let i = 0; i < 60; i++) await check(ip);
    expect((await check(ip)).status).toBe(429);
  });

  it("H-3: cédula is stored as the peppered HMAC, not bare SHA-256", async () => {
    await call("/api/admin/leaders", "test-admin-token", { name: "Ana", cedula: "1234567890", muni_code: "27001" });
    const row = await env.DB.prepare("SELECT cedula_hash FROM leaders").first<any>();
    expect(row.cedula_hash).toBe(await hashCedula(env, "1234567890")); // matches the peppered HMAC
    expect(row.cedula_hash).not.toBe(await sha256hex("1234567890")); // NOT the old brute-forceable digest
  });

  it("H-3: hashCedula fails closed when the pepper is unset", async () => {
    await expect(hashCedula({} as any, "1234567890")).rejects.toThrow(/CEDULA_PEPPER/);
  });
});

describe("feedback inbox → GitHub issues", () => {
  beforeAll(() => fetchMock.activate());

  const mockRefineAndGithub = (opts: { llmFails?: boolean; ghFails?: boolean } = {}) => {
    const or = fetchMock.get("https://openrouter.ai");
    or.cleanMocks();
    if (opts.llmFails) or.intercept({ path: "/api/v1/chat/completions", method: "POST" }).reply(500, "boom").persist();
    else
      or.intercept({ path: "/api/v1/chat/completions", method: "POST" })
        .reply(200, { choices: [{ message: { content: JSON.stringify({ title: "Corregir filtro de urgencia en tablero", body: "## Resumen\nEl filtro no aplica en la vista tablero." }) } }] })
        .persist();
    const gh = fetchMock.get("https://api.github.com");
    gh.cleanMocks();
    if (opts.ghFails) gh.intercept({ path: /.*/, method: "POST" }).reply(500, "{}").persist();
    else gh.intercept({ path: "/repos/test-org/test-repo/issues", method: "POST" }).reply(201, { html_url: "https://github.com/test-org/test-repo/issues/7" }).persist();
  };

  it("mod report becomes an AI-refined GitHub issue and is audited", async () => {
    mockRefineAndGithub();
    const res = await call("/api/feedback", "test-mod-token", {
      type: "bug", message: "el filtro de urgencia no funciona en el tablero",
      page: "/mod", device: { ua: "TestBrowser", pantalla: "800x600" },
    });
    expect(res.status).toBe(201);
    const d = (await res.json()) as any;
    expect(d.issue_url).toBe("https://github.com/test-org/test-repo/issues/7");
    expect(d.queued).toBe(false);
    const log = (await (await call("/api/admin/log", "test-admin-token")).json()) as any[];
    expect(log[0]).toMatchObject({ actor: "legacy-mod", action: "feedback" });
    expect(log[0].detail).toContain("issues/7");
  });

  it("LLM failure still files the issue with the raw message; GitHub failure queues in the log", async () => {
    mockRefineAndGithub({ llmFails: true });
    const d = (await (await call("/api/feedback", "test-mod-token", { type: "feature", message: "quiero exportar informes" })).json()) as any;
    expect(d.issue_url).toContain("issues/7"); // fallback title, still created

    mockRefineAndGithub({ ghFails: true });
    const d2 = (await (await call("/api/feedback", "test-mod-token", { type: "bug", message: "algo falló" })).json()) as any;
    expect(d2.queued).toBe(true);
    const log = (await (await call("/api/admin/log", "test-admin-token")).json()) as any[];
    expect(log[0].detail).toContain('"issue_url":null');
  });

  it("unauthenticated or invalid feedback is rejected", async () => {
    expect((await call("/api/feedback", "nope", { type: "bug", message: "x" })).status).toBe(401);
    expect((await call("/api/feedback", "test-mod-token", { type: "otro", message: "x" })).status).toBe(422);
  });
});

describe("reporting stats (PRD v2 P4)", () => {
  it("aggregates by day/need/muni/status with medians from the audit log", async () => {
    await env.DB.prepare(
      "INSERT INTO requests (need_type, urgency, channel, muni_code, muni_name, households, created_at) VALUES ('agua', 1, 'web', '27001', 'Quibdó', 5, datetime('now','-2 hours'))",
    ).run();
    await seedRequest(); // second agua/Quibdó, households default 1, created now
    const old = await env.DB.prepare("SELECT id FROM requests ORDER BY id LIMIT 1").first<any>();
    await call("/api/mod/action", "test-mod-token", { id: old.id, action: "verify" });

    const res = await call("/api/mod/stats?days=7", "test-mod-token");
    expect(res.status).toBe(200);
    const s = (await res.json()) as any;
    expect(s.totals.requests).toBe(2);
    expect(s.by_need).toEqual([{ need_type: "agua", n: 2 }]);
    expect(s.by_muni[0]).toMatchObject({ muni_name: "Quibdó", n: 2, households: 6 });
    const st = Object.fromEntries(s.by_status.map((r: any) => [r.status, r.n]));
    expect(st).toMatchObject({ pending: 1, verified: 1 });
    expect(s.median_hours_to_verify).toBeGreaterThan(1.9);
    expect(s.median_hours_to_verify).toBeLessThan(2.1);
    expect(s.median_hours_to_resolve).toBeNull();

    expect((await SELF.fetch("https://x/api/mod/stats")).status).toBe(401);
  });
});

describe("new categories + quantity", () => {
  it("higiene/infancia accepted end to end with quantity, editable by mods", async () => {
    const res = await webIntake({ need_types: ["higiene", "infancia"], muni_name: "Quibdó", quantity: "30 kits de aseo" });
    expect(res.status).toBe(201);
    const rows = (await (await call("/api/mod/requests?status=pending&need=higiene", "test-mod-token")).json()) as any[];
    expect(rows[0]).toMatchObject({ need_type: "higiene", quantity: "30 kits de aseo" });

    await call("/api/mod/action", "test-mod-token", { id: rows[0].id, action: "update", quantity: "50 kits de aseo" });
    const edited = (await (await call("/api/mod/requests?status=pending&need=higiene", "test-mod-token")).json()) as any[];
    expect(edited[0].quantity).toBe("50 kits de aseo");
  });

  it("org push accepts new categories and quantity through the open schema", async () => {
    const res = await SELF.fetch("https://x/api/requests", {
      method: "POST",
      headers: { authorization: "Bearer test-org-token", "content-type": "application/json" },
      body: JSON.stringify({ need_type: "infancia", location: { muni_name: "Istmina" }, quantity: "200 pañales", households: 10 }),
    });
    expect(res.status).toBe(201);
    const rows = (await (await call("/api/mod/requests?status=pending&need=infancia", "test-mod-token")).json()) as any[];
    expect(rows[0]).toMatchObject({ quantity: "200 pañales", source_org: "CruzRoja" });
  });
});
