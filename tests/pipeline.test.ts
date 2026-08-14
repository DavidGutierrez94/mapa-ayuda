import { SELF, env, fetchMock } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

// ── Helpers ──

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mockLLM(triage: object) {
  const pool = fetchMock.get("https://openrouter.ai");
  pool.cleanMocks(); // one active LLM stub per test — persistent mocks otherwise shadow later ones
  pool
    .intercept({ path: "/api/v1/chat/completions", method: "POST" })
    .reply(200, { choices: [{ message: { content: JSON.stringify(triage) } }] })
    .persist();
}

async function kapsoWebhook(msg: { id: string; from: string; text?: string; buttonId?: string }) {
  const body = JSON.stringify({
    message: {
      id: msg.id,
      from: msg.from,
      ...(msg.buttonId
        ? { interactive: { button_reply: { id: msg.buttonId, title: "x" } } }
        : { text: { body: msg.text ?? "" } }),
    },
  });
  return SELF.fetch("https://x/webhook/kapso", {
    method: "POST",
    headers: { "X-Webhook-Signature": await hmacHex("test-kapso-secret", body) },
    body,
  });
}

const feed = async (qs = "status=verified,attending") =>
  (await (await SELF.fetch(`https://x/api/feed?${qs}`)).json()) as any;

const modQueue = async () =>
  (await (
    await SELF.fetch("https://x/api/mod/queue", { headers: { authorization: "Bearer test-mod-token" } })
  ).json()) as any[];

const modAction = (body: object) =>
  SELF.fetch("https://x/api/mod/action", {
    method: "POST",
    headers: { authorization: "Bearer test-mod-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(() => {
  // Kapso outbound sends must not hit the network in tests.
  fetchMock.activate();
  fetchMock.get("https://api.kapso.ai").intercept({ path: /.*/, method: "POST" }).reply(200, {}).persist();
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM confirmations; DELETE FROM pending_actions; DELETE FROM requests; DELETE FROM raw_messages;");
});

// ── Acceptance criteria ──

describe("intake → triage → moderation → feed", () => {
  it("WhatsApp message lands in the moderation queue, classified", async () => {
    mockLLM({ need_type: "agua", urgency: 1, description: "Necesitan agua en Quibdó", location_raw: "Quibdó", households: 12 });
    const res = await kapsoWebhook({ id: "wamid.1", from: "573001112233", text: "necesitamos agua en quibdó, somos 12 familias" });
    expect(res.status).toBe(200);
    const queue = await modQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ need_type: "agua", urgency: 1, muni_code: "27001", channel: "whatsapp", households: 12 });
  });

  it("bad signature is rejected", async () => {
    const res = await SELF.fetch("https://x/webhook/kapso", {
      method: "POST", headers: { "X-Webhook-Signature": "deadbeef" }, body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("duplicate webhook delivery (same message id) creates exactly one request", async () => {
    mockLLM({ need_type: "techo", urgency: 2, description: "x", location_raw: "Istmina", households: 1 });
    await kapsoWebhook({ id: "wamid.dup", from: "573001", text: "se cayó la casa en istmina" });
    await kapsoWebhook({ id: "wamid.dup", from: "573001", text: "se cayó la casa en istmina" });
    expect(await modQueue()).toHaveLength(1);
  });

  it("nothing appears publicly before moderation; approve → feed; reject → never public", async () => {
    mockLLM({ need_type: "medico", urgency: 1, description: "heridos", location_raw: "Condoto", households: 3 });
    await kapsoWebhook({ id: "wamid.2", from: "573002", text: "hay heridos en condoto" });
    expect((await feed()).rows).toHaveLength(0); // human gate

    const [req] = await modQueue();
    await modAction({ id: req.id, action: "verify" });
    const rows = (await feed()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ muni_code: "27205", need_type: "medico", status: "verified" });

    await modAction({ id: req.id, action: "reject" });
    expect((await feed()).rows).toHaveLength(0);
  });

  it("web form with several needs creates one request per need", async () => {
    const res = await SELF.fetch("https://x/api/web-intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ need_types: ["agua", "alimentos", "agua"], urgency: 2, muni_name: "Quibdó", households: 3, contact: "573001" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).ids).toHaveLength(2); // deduped
    const queue = await modQueue();
    expect(queue.map((r) => r.need_type).sort()).toEqual(["agua", "alimentos"]);
    expect(queue.every((r) => r.muni_code === "27001" && r.households === 3)).toBe(true);
  });

  it("SMS via SMSGate flows through the same pipeline", async () => {
    mockLLM({ need_type: "alimentos", urgency: 2, description: "comida", location_raw: "Tadó", households: 5 });
    const body = JSON.stringify({
      event: "sms:received", id: "evt1", webhookId: "wh1", deviceId: "dev1",
      payload: { messageId: "sms-1", message: "no hay comida en tadó", sender: "573009998877", receivedAt: "2026-08-13T10:00:00Z" },
    });
    const ts = "1755080000";
    const res = await SELF.fetch("https://x/webhook/smsgate", {
      method: "POST",
      headers: { "X-Signature": await hmacHex("test-smsgate-key", body + ts), "X-Timestamp": ts },
      body,
    });
    expect(res.status).toBe(200);
    const queue = await modQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ channel: "sms", need_type: "alimentos", muni_code: "27787" });
  });
});

describe("confirmations (sumarse)", () => {
  it("matching report asks to join; 'sí' adds +1 without a new queue item; same phone can't double-count", async () => {
    mockLLM({ need_type: "agua", urgency: 2, description: "agua", location_raw: "Quibdó", households: 1 });
    await kapsoWebhook({ id: "w1", from: "5730010", text: "agua en quibdó" });
    const [req] = await modQueue();

    // Second phone reports the same need+muni → bot asks, no new request yet
    await kapsoWebhook({ id: "w2", from: "5730020", text: "también falta agua en quibdó" });
    expect(await modQueue()).toHaveLength(1);

    // Says yes → confirmation recorded
    await kapsoWebhook({ id: "w3", from: "5730020", buttonId: "btn_sumar" });
    expect(await modQueue()).toHaveLength(1);
    await modAction({ id: req.id, action: "verify" });
    expect((await feed()).rows[0].reportes).toBe(2); // 1 request + 1 confirmation

    // Same phone tries again → asked again, confirms again → count unchanged
    await kapsoWebhook({ id: "w4", from: "5730020", text: "sigue faltando agua en quibdó" });
    await kapsoWebhook({ id: "w5", from: "5730020", buttonId: "btn_sumar" });
    expect((await feed()).rows[0].reportes).toBe(2);
  });

  it("'nueva solicitud' button creates a separate request from the saved payload", async () => {
    mockLLM({ need_type: "agua", urgency: 2, description: "agua", location_raw: "Quibdó", households: 4 });
    await kapsoWebhook({ id: "n1", from: "5730030", text: "agua en quibdó" });
    await kapsoWebhook({ id: "n2", from: "5730040", text: "agua en quibdó barrio distinto" });
    await kapsoWebhook({ id: "n3", from: "5730040", buttonId: "btn_nueva" });
    expect(await modQueue()).toHaveLength(2);
  });
});

describe("open intake API", () => {
  const push = (body: object, token = "test-org-token") =>
    SELF.fetch("https://x/api/requests", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("valid schema body → 201 into triage queue with source org", async () => {
    const res = await push({ need_type: "techo", urgency: 2, location: { muni_name: "Pereira" }, households: 8 });
    expect(res.status).toBe(201);
    const [req] = await modQueue();
    expect(req).toMatchObject({ source_org: "CruzRoja", muni_code: "66001", channel: "api" });
  });

  it("invalid schema → 422 with error details", async () => {
    const res = await push({ need_type: "invalid", location: {}, extra_field: 1 });
    expect(res.status).toBe(422);
    const data = (await res.json()) as any;
    expect(data.details.length).toBeGreaterThan(0);
  });

  it("bad token → 401", async () => {
    expect((await push({ need_type: "agua", location: { raw: "x" } }, "wrong")).status).toBe(401);
  });

  it("identical push is idempotent", async () => {
    const body = { need_type: "agua", location: { muni_name: "Cali" } };
    await push(body);
    await push(body);
    expect(await modQueue()).toHaveLength(1);
  });
});

describe("PII boundary", () => {
  it("public feed (json+csv) exposes zero phones/precise locations; responder endpoint exposes both", async () => {
    mockLLM({ need_type: "rescate", urgency: 1, description: "atrapados", location_raw: "San José del Palmar", households: 2 });
    await kapsoWebhook({ id: "p1", from: "573216667788", text: "hay gente atrapada en san josé del palmar vereda la esperanza" });
    const [req] = await modQueue();
    await modAction({ id: req.id, action: "verify" });

    const feedText = JSON.stringify(await feed());
    expect(feedText).not.toContain("573216667788");
    expect(feedText).not.toContain("esperanza");

    const csv = await (await SELF.fetch("https://x/api/feed?format=csv")).text();
    expect(csv).not.toContain("573216667788");

    const respRes = await SELF.fetch("https://x/api/responder/requests", {
      headers: { authorization: "Bearer test-responder-token" },
    });
    const rows = (await respRes.json()) as any[];
    expect(rows[0].contact).toBe("573216667788");

    // no token → denied
    expect((await SELF.fetch("https://x/api/responder/requests")).status).toBe(401);
  });
});

describe("mod dashboard: CRUD, search, tabs", () => {
  const list = async (qs: string) =>
    (await (
      await SELF.fetch(`https://x/api/mod/requests?${qs}`, { headers: { authorization: "Bearer test-mod-token" } })
    ).json()) as any[];
  const create = (body: object) =>
    SELF.fetch("https://x/api/mod/create", {
      method: "POST",
      headers: { authorization: "Bearer test-mod-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("manual create lands as pending (human gate applies to moderators too)", async () => {
    const res = await create({ need_type: "medico", urgency: 1, muni_name: "Quibdó", description: "llamada telefónica: heridos", households: 3, contact: "573000000001" });
    expect(res.status).toBe(201);
    expect((await feed()).rows).toHaveLength(0);
    const [req] = await list("status=pending");
    expect(req).toMatchObject({ channel: "manual", muni_code: "27001", need_type: "medico" });
  });

  it("manual create accepts several needs, one request per need", async () => {
    const res = await create({ need_types: ["agua", "techo"], urgency: 2, muni_name: "Istmina", households: 4 });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).ids).toHaveLength(2);
    expect((await list("status=pending")).map((r: any) => r.need_type).sort()).toEqual(["agua", "techo"]);
  });

  it("listing filters by status, need and urgency; search matches text, id and municipality", async () => {
    await create({ need_type: "agua", urgency: 2, muni_name: "Quibdó", description: "falta agua" });
    await create({ need_type: "techo", urgency: 1, muni_name: "Istmina", description: "carpas urgentes" });
    expect(await list("status=pending")).toHaveLength(2);
    expect((await list("status=pending&need=techo"))[0].muni_name).toBe("Istmina");
    expect(await list("status=pending&urgency=2")).toHaveLength(1);
    expect((await list("status=pending&q=carpas"))[0].need_type).toBe("techo");
    expect(await list("status=pending&q=Quibdó")).toHaveLength(1);
    expect(await list("status=verified")).toHaveLength(0);
    const [req] = await list("status=pending&need=agua");
    await modAction({ id: req.id, action: "verify" });
    expect(await list("status=verified")).toHaveLength(1);
    expect((await list(`status=pending&q=${req.id}`))).toHaveLength(0); // id search is status-scoped
  });

  it("update action edits fields without touching status", async () => {
    await create({ need_type: "otro", urgency: 3, muni_name: "Quibdó", description: "texto confuso" });
    const [req] = await list("status=pending");
    await modAction({ id: req.id, action: "update", need_type: "rescate", urgency: 1, households: 7, description: "personas atrapadas", contact: "573000000009" });
    const [edited] = await list("status=pending");
    expect(edited).toMatchObject({ need_type: "rescate", urgency: 1, households: 7, description: "personas atrapadas", contact: "573000000009", status: "pending" });
  });

  it("delete removes the request and its confirmations", async () => {
    await create({ need_type: "agua", urgency: 2, muni_name: "Quibdó" });
    const [req] = await list("status=pending");
    await env.DB.prepare("INSERT INTO confirmations (request_id, phone) VALUES (?, '57300xyz')").bind(req.id).run();
    await modAction({ id: req.id, action: "delete" });
    expect(await list("status=pending")).toHaveLength(0);
    const c = await env.DB.prepare("SELECT COUNT(*) n FROM confirmations").first<any>();
    expect(c.n).toBe(0);
  });
});

describe("responder case management", () => {
  const respAction = (body: object, token = "test-responder-token") =>
    SELF.fetch("https://x/api/responder/action", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("responder moves verified → attending → resolved, but cannot touch pending cases", async () => {
    mockLLM({ need_type: "agua", urgency: 1, description: "agua", location_raw: "Quibdó", households: 2 });
    await kapsoWebhook({ id: "r1", from: "5730050", text: "agua en quibdó" });
    const [req] = await modQueue();

    // Pending case: responder action is a no-op (human gate stays with moderators)
    await respAction({ id: req.id, action: "attend" });
    expect(await modQueue()).toHaveLength(1);

    await modAction({ id: req.id, action: "verify" });
    expect((await respAction({ id: req.id, action: "attend" })).status).toBe(200);
    expect((await feed("status=attending")).rows).toHaveLength(1);

    await respAction({ id: req.id, action: "resolve" });
    expect((await feed("status=resolved")).rows).toHaveLength(1);
  });

  it("verify/reject are not valid responder actions; bad token → 401", async () => {
    expect((await respAction({ id: 1, action: "verify" })).status).toBe(400);
    expect((await respAction({ id: 1, action: "attend" }, "wrong")).status).toBe(401);
  });
});

describe("LLM failure resilience", () => {
  it("LLM error still captures the report as 'otro' for moderator fixing", async () => {
    const pool = fetchMock.get("https://openrouter.ai");
    pool.cleanMocks();
    pool.intercept({ path: "/api/v1/chat/completions", method: "POST" }).reply(500, "boom").persist();
    await kapsoWebhook({ id: "f1", from: "5730099", text: "auxilio en mi vereda" });
    const queue = await modQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0].need_type).toBe("otro");
  });
});

describe("ipMatch signal", () => {
  it("accent-insensitive match, mismatch, unknown", async () => {
    const { ipMatch } = await import("../src/index");
    expect(ipMatch("Quibdo", "Quibdó")).toBe(1);
    expect(ipMatch("Bogotá", "Quibdó")).toBe(0);
    expect(ipMatch(null, "Quibdó")).toBeNull();
    expect(ipMatch("Quibdó", null)).toBeNull();
  });
});

describe("triage quantity extraction", () => {
  it("quantity from the LLM lands on the request", async () => {
    mockLLM({ need_type: "higiene", urgency: 2, description: "kits de aseo", location_raw: "Quibdó", households: 8, quantity: "40 kits" });
    await kapsoWebhook({ id: "q1", from: "5730077", text: "necesitamos 40 kits de aseo en quibdó para 8 familias" });
    const [req] = await modQueue();
    expect(req).toMatchObject({ need_type: "higiene", quantity: "40 kits", muni_code: "27001" });
  });
});
