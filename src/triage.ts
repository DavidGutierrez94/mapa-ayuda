import type { Env, TriagedReport } from "./types";

const NEED_TYPES = ["agua", "alimentos", "medico", "rescate", "techo", "higiene", "infancia", "otro"];

const SYSTEM = `Eres el clasificador de solicitudes de ayuda tras el terremoto en Colombia.
Recibes un mensaje de una persona afectada (o de alguien reportando por su comunidad).
Responde SOLO un objeto JSON con:
- need_type: uno de ${NEED_TYPES.join(", ")} (la necesidad principal; higiene = kits de aseo/cuidado personal; infancia = pañales, fórmula, ropa o artículos para niños y bebés)
- urgency: 1 (vida en riesgo ahora), 2 (urgente, horas), 3 (necesidad sostenida, días)
- description: resumen claro en una frase, en español
- location_raw: el lugar mencionado (municipio, vereda, barrio) o null si no se menciona
- households: número de familias/hogares afectados que se mencionan (1 si no se especifica)
- quantity: cantidad concreta mencionada de lo que se necesita (ej: "20 mercados", "100 litros"), o null`;

const FALLBACK = (text: string): TriagedReport => ({
  need_type: "otro",
  urgency: 2,
  description: text.slice(0, 500),
  location_raw: null,
  households: 1,
  quantity: null,
});

export async function llmTriage(env: Env, text: string): Promise<TriagedReport> {
  try {
    const res = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.LLM_API_KEY ?? ""}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: text },
        ],
      }),
    });
    if (!res.ok) return FALLBACK(text);
    const data = (await res.json()) as any;
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(raw.replace(/^```(json)?|```$/g, "").trim());
    return {
      need_type: NEED_TYPES.includes(parsed.need_type) ? parsed.need_type : "otro",
      urgency: [1, 2, 3].includes(parsed.urgency) ? parsed.urgency : 2,
      description: String(parsed.description ?? text).slice(0, 500),
      location_raw: parsed.location_raw ? String(parsed.location_raw) : null,
      households: Number.isInteger(parsed.households) && parsed.households > 0 ? parsed.households : 1,
      quantity: parsed.quantity ? String(parsed.quantity).slice(0, 100) : null,
    };
  } catch {
    // LLM down or unparseable → still capture the report; moderator fixes it.
    return FALLBACK(text);
  }
}
