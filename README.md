# Mapa de Ayuda 🇨🇴

**ES** — Plataforma open source de visibilidad de necesidades tras el terremoto del Chocó
(10 de agosto de 2026). Las personas afectadas reportan necesidades (agua, alimentos,
atención médica, rescate, techo) por **WhatsApp, SMS o formulario web**; un triaje con IA
más moderación humana las verifica; y un **mapa público** muestra las necesidades agregadas
por municipio. Los organismos de ayuda acreditados ven la ubicación precisa y el contacto.

**EN** — Open-source needs-visibility platform for the Chocó earthquake (Aug 10, 2026).
Affected people report needs via **WhatsApp, SMS, or web form**; AI triage plus human
moderation verifies them; a **public map** shows needs aggregated by municipality.
Accredited responders see precise locations and contact info.

> Personas desaparecidas / missing persons → use **Colombia Te Busca** and the
> Asocapitales tool. This project deliberately does not duplicate that layer.

## How it works

```
WhatsApp (Kapso) ─┐
SMS (SMSGate)    ─┤→ adapter → idempotent store → AI triage → HUMAN GATE → public map
Web form         ─┤   (normalize)   (D1)      (LLM+gazetteer)  (moderator)  + open feed
Org API push     ─┘
```

- **Nothing is public without human verification.** Requests enter a moderation queue;
  only verified ones reach the map and feed.
- **Confirmations instead of duplicates ("sumarse")**: a report matching an existing
  request becomes a +1 (one per phone, DB-enforced), raising its priority.
- **Privacy split**: the public feed is aggregated by municipality — zero phone numbers,
  zero precise locations. Accredited responders access full detail with a token.

## Open intake standard

Any org or bridge can push requests: `POST /api/requests` (Bearer token) with a body
matching [`schema/help-request.schema.json`](schema/help-request.schema.json).
Anyone can consume: `GET /api/feed` (JSON), `?format=csv` (for orgs, no integration
needed), `?format=geojson` (for maps).

## Stack

Cloudflare Workers + D1 + static assets · [Kapso](https://kapso.com) (WhatsApp) ·
[SMSGate](https://github.com/capcom6/android-sms-gateway) (SMS via an Android phone with a
Colombian SIM) · any OpenAI-compatible LLM for triage (default OpenRouter) · MapLibre + OSM.

## Deploy your own

```bash
npm install
npx wrangler d1 create mapa-ayuda        # put the id in wrangler.jsonc
npm run db:migrate
npm run deploy
```

Secrets (`npx wrangler secret put NAME`): `LLM_API_KEY`, `KAPSO_API_KEY`,
`KAPSO_PHONE_ID`, `KAPSO_WEBHOOK_SECRET`, `SMSGATE_SIGNING_KEY`, `SMSGATE_LOGIN`,
`SMSGATE_PASSWORD`, `TURNSTILE_SECRET`, `TURNSTILE_SITEKEY`, `MOD_TOKEN`,
`RESPONDER_TOKEN`, `ORG_TOKENS` (format `OrgName:token,Other:token`).

SMS gateway: install SMSGate on an Android 5+ phone with a prepaid Colombian SIM (eSIM
works — Tigo sells prepaid eSIM fully online), enable webhooks pointing at
`/webhook/smsgate`, keep the phone powered and in coverage.

## Development

```bash
npm run db:migrate:local
npm run dev        # http://localhost:8787
npm test           # secrets-free; LLM and providers are mocked
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues: full DANE municipality
gazetteer, Telegram bridge adapter, voice-note intake, municipality choropleth boundaries.

MIT — built for the emergency, reusable for the next one.
