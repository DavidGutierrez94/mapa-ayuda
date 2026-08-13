# PRD: Mapa de Ayuda — Colombia earthquake needs-visibility platform

**Status:** draft · **Risk:** medium · **Date:** 2026-08-13

## Problem / goal
The Aug 10 M7.4 Chocó earthquake left 355+ municipalities damaged with no public, live picture of *what help is needed where*. Existing channels (Cruz Roja WhatsApp, 123, Army lines) are intake silos with no shared feed; missing persons is covered by Colombia Te Busca, needs are not. We ship an open-source platform where affected people report needs via WhatsApp or SMS, AI + human moderators verify them, and a public map plus an open feed give responders (Cruz Roja, Defensa Civil, volunteer groups) one actionable picture. Success is observable: verified requests on the map, and at least one external org consuming the feed or pushing into the API.

## Scope
- **In (MVP):**
  - WhatsApp intake bot (Spanish, relay-first: one reporter can file needs for many households/a vereda)
  - SMS intake fallback (same parser, structured-ish free text)
  - Web form intake on the public site (Spanish, mobile-first): structured fields (need type, location, households, contact phone) posting into the same pipeline as a `web` adapter; spam-gated with Cloudflare Turnstile + IP rate limits
  - AI triage: dedupe, classify need type (agua, alimentos, médico, rescate, techo, otro), urgency, extract/geocode location → moderator queue
  - Confirmations ("sumarse"): a report matching an existing request becomes a +1 on it (bot asks "¿quieres sumarte?"), not a new queue item; count shown on map as the priority signal. Gated: one confirmation per phone per request, standard rate limits
  - Human gate: nothing publishes until a moderator approves (estados: `recibido → en_revisión → verificado | rechazado → en_atención → resuelto`)
  - Public web map: heat map aggregated by municipality, filter by need type/status; counts only, no PII
  - Responder view: accredited accounts (invite-only tokens) see precise location + contact
  - Open intake standard: published JSON schema + `POST /api/requests` (token) + public read feed `GET /api/feed` (GeoJSON + CSV)
  - WhatsApp Channel for verified broadcasts (manual posting, no API needed)
  - Links page to existing resources (Colombia Te Busca, líneas oficiales)
- **Out:**
  - Missing persons (link out only) · donations/money · pull-scraping other platforms · multi-disaster tenancy · public user accounts · native apps · English UI (docs bilingual, product Spanish-only)

## Design / approach
Reuse the `whatsapp-booking-bot` stack wholesale (Cloudflare Workers + D1 + WhatsApp webhook handling already proven there) — that's the ponytail alternative to any new backend framework.

- **Intake:** channel adapters behind one interface (inbound → normalized `RawReport`). v1 adapters: **Kapso** for WhatsApp (instant managed production number — no Meta WABA wait; native buttons/lists power the "sumarse" and relay flows) and **SMSGate** (open-source capcom6/android-sms-gateway) for SMS — an Android phone with a prepaid Colombian SIM posts incoming SMS as webhooks, giving affected people a free-to-text local number (Twilio dropped: no SMS-capable Colombian local numbers; a US number would cost senders international rates). Webhook → Worker → raw message stored in D1 (idempotency key = provider message ID, kills webhook-retry duplicates). Adapter boundary doubles as the OSS contribution surface (Telegram, voice, etc.) and the exit route if a provider becomes a liability.
- **Triage:** queued Worker calls an OpenAI-compatible LLM endpoint configured via env (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) — default OpenRouter with a cheap capable model; any deployer can swap provider/model without code changes. Fixed JSON output contract: need types, urgency 1–3, location string → matched against a DANE municipality gazetteer (static JSON in the repo; manual fallback field for veredas geocoders miss). Cost note: ~$0.002/message on Haiku-class pricing; triage runs live, so the Batch API discount doesn't apply. Human gate catches classification errors, so a cheaper model is acceptable. Flags probable duplicates by phone + location + need overlap; a confirmed match becomes a confirmation (+1) on the existing request via the bot's "¿quieres sumarte?" flow — reuses dedupe instead of a separate public voting system (alternative considered and cut: web like button — spam surface, and it measures spectators' attention, not affected people's need). Channel broadcasts carry the "confirma, no repitas" awareness message.
- **Moderation:** minimal dashboard (same Worker, server-rendered or tiny static page + API) — approve/reject/merge/resolve. Moderator auth: shared-secret magic links for MVP.
- **Public map:** static page on Cloudflare Pages, MapLibre + free OSM tiles, municipality choropleth from `GET /api/feed?agg=municipio`. Loads on 3G low-end Android.
- **Open standard:** `schema/help-request.schema.json` (JSON Schema, versioned) + bilingual `CONTRIBUTING.md`. External orgs push with a write token; everyone reads the public feed. Contributors build bridges (Telegram, forms, other orgs) against the schema instead of us integrating N sources.
- **Data note:** phone numbers and precise coords never leave the responder-scoped endpoints. Public feed is aggregate-only.

## Acceptance criteria
- [ ] WhatsApp message describing a need → appears in moderator queue with AI classification in < 1 min
- [ ] SMS to the SMSGate number → same queue, same pipeline
- [ ] Moderator approves → request visible in public aggregated feed and map immediately; rejects → never public
- [ ] Relay flow: one WhatsApp conversation can file ≥ 2 distinct requests for different families/places
- [ ] Duplicate webhook delivery (same SID) creates exactly one request
- [ ] Report matching an existing request + "sí, sumarme" → confirmation count +1, no new queue item; same phone confirming twice → count unchanged
- [ ] `POST /api/requests` with valid token + schema-valid body → accepted into triage; invalid schema → 422 with errors
- [ ] Web form submission with valid Turnstile token → same queue, same pipeline; missing/invalid Turnstile → rejected
- [ ] Public feed exposes zero phone numbers / precise coords; responder endpoint (valid token) exposes both
- [ ] `GET /api/feed?format=csv` downloadable without auth
- [ ] Map renders choropleth with filters on a 3G-throttled low-end phone in < 5 s
- [ ] CI passes on a fork PR with zero repo secrets available; merge to `main` deploys Worker + Pages without manual steps

## Test plan
- **E2E (vitest + miniflare/wrangler dev):** simulated Twilio webhook → triage (mocked Claude) → moderator approve via API → assert public feed contents. One test per acceptance criterion above; the duplicate-SID and PII-leak tests are the highest-signal.
- **Schema:** golden-file tests validating example payloads (valid + invalid) against `help-request.schema.json`.
- **Smoke:** `npm test` + `wrangler dev` + `curl` script hitting webhook → feed round-trip.

## Risks & open questions
- **Bad/fake data on a public map** → mitigations: human gate (nothing unverified publishes), per-phone rate limit, moderator takedown. Load-bearing, not cosmetic.
- **Moderator capacity is the bottleneck** — the gate needs humans on day one. Open question: who moderates at launch (David + volunteers? recruit via the OSS repo?).
- **Kapso dependency** (startup as WhatsApp provider for critical infra) → channel-adapter interface keeps the swap cost to one file; free tier limits unknown — verify starter usage covers launch volume, budget for Pro. Meta conversation fees pass through regardless of provider.
- **SMSGate is one physical phone** — battery/signal/uptime risk → heartbeat monitoring, keep it powered and in coverage; add a second phone+SIM if SMS volume proves meaningful.
- **Geocoding veredas** — gazetteer will miss hamlets; manual location field + moderator correction covers it.
- **Partnership risk:** Red Cross may not consume the feed → CSV export requires zero integration from them; visibility alone still has value.
- Open question: domain name + project name (placeholder: Mapa de Ayuda / `mapa-ayuda`).

## Rollout / follow-ups
- **Secrets:** Kapso API key, SMSGate webhook signing secret, Turnstile site/secret keys, LLM env (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` — default OpenRouter), moderator/responder tokens → Wrangler secrets.
- **Hardware:** one Android phone (5.0+) with prepaid Colombian SIM running SMSGate, plugged in with signal; heartbeat monitor alerts if the gateway goes silent. Second phone+SIM as cheap redundancy later.
- **Deploy / CI-CD (contribution-ready from day one):** GitHub Actions — CI on every PR (lint + tests + schema golden files, all secrets-free via mocked Claude/Twilio so fork PRs pass), CD on merge to `main` (wrangler deploys Worker + D1 migrations + Pages), Pages preview URL per PR for frontend changes. Branch protection: green CI required, no direct pushes to `main`. Repo public on GitHub (MIT) from first commit; bilingual README + CONTRIBUTING with good-first-issues (Telegram bridge, voice intake, i18n). No Worker preview envs in MVP.
- **Deferred:** Meta WABA migration, AI auto-verify for trusted reporters, multi-disaster generalization, voice-note intake.
