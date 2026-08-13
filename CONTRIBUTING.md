# Contributing / Contribuir

**ES** — Gracias por ayudar. El proyecto está en producción durante una emergencia real:
los PRs pequeños y enfocados se revisan más rápido. Todo el texto visible para personas
afectadas va en español.

**EN** — Thanks for helping. This runs in production during a real emergency: small,
focused PRs get reviewed fastest. All text shown to affected people is in Spanish.

## Setup

```bash
npm install
npm run db:migrate:local
npm run dev
npm test
```

Tests are **secrets-free** (LLM and messaging providers are mocked), so CI passes on fork
PRs with zero repository secrets. `main` is protected: green CI required, merge deploys
automatically.

## Where help is most useful

1. **Full DANE gazetteer** — [`data/municipios.json`](data/municipios.json) covers ~30
   municipalities; Colombia has ~1,120. Source: DANE Divipola. Keep the same shape.
2. **New intake adapters** — one file in [`src/adapters/`](src/adapters/) that normalizes
   an inbound message to `RawReport` (see `types.ts`) plus a webhook route. Telegram and
   voice-note transcription are wanted. Verify webhook signatures — no exceptions.
3. **Bridges from other platforms** — push into `POST /api/requests` against
   [`schema/help-request.schema.json`](schema/help-request.schema.json). These can live in
   your own repo; we'll link them.
4. **Municipality choropleth** — the map currently draws proportional symbols at
   centroids; a lightweight boundaries GeoJSON would upgrade it.

## Rules

- The **human gate is load-bearing**: nothing may become publicly visible without
  moderator verification. Don't weaken it.
- The **PII boundary is absolute**: phone numbers and precise locations never appear in
  public endpoints. The test suite enforces this; extend those tests when touching the feed.
- Keep diffs minimal; match the existing style (no frameworks, no new runtime deps
  without discussion).
- Every non-trivial change ships with a test.
