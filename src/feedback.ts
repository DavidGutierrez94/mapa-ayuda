import type { Env } from "./types";

export interface FeedbackInput {
  type: "bug" | "feature";
  message: string;
  page?: string | null;
  device?: Record<string, unknown> | null;
  actor: string;
  role: string;
}

/** LLM-refined issue title/body; falls back to the raw message so a report is never lost. */
export async function refineIssue(env: Env, f: FeedbackInput): Promise<{ title: string; body: string }> {
  const fallback = {
    title: `[${f.type === "bug" ? "bug" : "solicitud"}] ${f.message.slice(0, 70)}`,
    body: f.message,
  };
  if (!env.LLM_API_KEY) return withMeta(fallback, f);
  try {
    const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.LLM_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'Eres el asistente de issues del proyecto open-source "Mapa de Ayuda" (Cloudflare Workers + D1, mapa de necesidades del terremoto del Chocó). ' +
              "Recibes un reporte informal de un moderador o administrador y lo conviertes en un issue de GitHub claro y accionable, en español. " +
              'Responde SOLO JSON: {"title": "...", "body": "..."}. ' +
              "title: imperativo, ≤70 caracteres. body: markdown con secciones Resumen y, si es un error, Pasos para reproducir / Comportamiento esperado. " +
              "No inventes detalles que el reporte no diga; conserva la cita textual del mensaje original al final bajo la sección Mensaje original.",
          },
          { role: "user", content: `Tipo: ${f.type}\nPágina: ${f.page ?? "?"}\nReporte:\n${f.message}` },
        ],
      }),
    });
    if (!res.ok) return withMeta(fallback, f);
    const data = (await res.json()) as any;
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
    if (!parsed.title || !parsed.body) return withMeta(fallback, f);
    return withMeta({ title: String(parsed.title).slice(0, 100), body: String(parsed.body) }, f);
  } catch {
    return withMeta(fallback, f);
  }
}

function withMeta(issue: { title: string; body: string }, f: FeedbackInput): { title: string; body: string } {
  const device = f.device
    ? Object.entries(f.device)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(" · ")
    : null;
  const meta = [
    "",
    "---",
    `**Reportado desde la plataforma** por rol \`${f.role}\` en \`${f.page ?? "?"}\`.`,
    ...(device ? [`**Dispositivo:** ${device}`] : []),
  ].join("\n");
  return { title: issue.title, body: issue.body + meta };
}

/** Returns the created issue URL, or null when GitHub is not configured / the call fails. */
export async function createGithubIssue(
  env: Env,
  issue: { title: string; body: string },
  labels: string[],
): Promise<string | null> {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "mapa-ayuda-feedback",
      },
      body: JSON.stringify({ title: issue.title, body: issue.body, labels }),
    });
    if (!res.ok) return null;
    return ((await res.json()) as any).html_url ?? null;
  } catch {
    return null;
  }
}
