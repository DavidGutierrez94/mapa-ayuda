# PRD: v2 — Red Cross session feedback (trust, roles, reporting)

**Status:** approved 2026-08-14 (decisions: hybrid leader lane; cédula hash+last3; /informes for mods+responders; P1→P4 order) · **Risk:** med-high · **Date:** 2026-08-14

## Problem / goal
Feedback from the Cruz Roja session: the platform needs stronger *trust signals* (who reported, from where, verifiable), *accountability* (who moderated what, with what role), and *reporting* (charts/metrics for coordination meetings). Success = a Red Cross coordinator can onboard social leaders, trace every moderation decision, and export a situation report without asking us.

## Scope
- **In (4 phases, shippable independently):**
  - **P1 Roles + audit log** — named users with roles (admin / mod / responder), every mod action logged and traceable.
  - **P2 Social-leader registry** — admin-managed leaders with gated submission links (token + cédula check); leader reports get a trust badge.
  - **P3 Form v2 + geolocation** — richer intake form (reporter name/type, people count, vulnerable groups, road access), browser GPS capture, server-side IP-vs-municipality cross-check as a moderation signal.
  - **P4 Reporting** — stats endpoint + printable charts page (requests over time, by need/muni/status, resolution times).
- **Out:** photo/evidence upload (needs R2; revisit after P3), WhatsApp-side leader auth, offline/PWA mode, multi-tenant orgs, replacing the human gate with auto-verification (leader reports still pass moderation).

## Design / approach

**Migration `migrations/0002_roles_leaders_audit.sql`:**
- `users` (id, name, role CHECK admin|mod|responder, token_hash, active, created_by, created_at) — replaces the single MOD_TOKEN / RESPONDER_TOKEN over time; `ADMIN_TOKEN` env secret stays as bootstrap + break-glass.
- `leaders` (id, name, phone, muni_code, cedula_hash, cedula_last3, link_token, active, created_by, created_at) — raw cédula is **never stored** (SHA-256 hash + last 3 digits for human confirmation), per Habeas Data minimization.
- `mod_log` (id, actor, role, action, request_id, detail, created_at) — appended by every write in `/api/mod/*` and `/api/responder/action`.
- `requests` add columns: `leader_id`, `reporter_name`, `people_count`, `vulnerable` (JSON), `access_note`, `precise_lat`, `precise_lon`, `ip_city`, `ip_match` — the last four are PRIVATE (responder/mod only; the feed already never selects new columns, and PII tests extend to them).

**P1 — `src/index.ts`:** auth helper resolves bearer → user+role (hash compare vs `users`, fallback to legacy env tokens during migration window). Admin-only routes: `POST/GET /api/admin/users`, `GET /api/admin/log`. All existing mod/responder handlers call `logAction(env, actor, ...)`. New `public/admin.html` (coss-styled): user CRUD + audit log table with filters.

**P2 — leaders:** `POST/GET /api/admin/leaders` (+ revoke). Gated link `/ayuda?lider=<link_token>`: form shows a "Líder comunitario" section asking cédula; `/api/web-intake` verifies token + cédula-hash match, stamps `leader_id`. Mod queue + `/casos` cards show a ✓ "Líder: <name> (CC …last3)" badge. Open intake **stays open** (see open question 1) — leader lane adds trust, does not close the public door.

**P3 — form v2 (`public/ayuda.html`):** sectioned single page (Necesidad → Ubicación → Personas → Contacto), new optional fields, "📍 Usar mi ubicación" button (browser Geolocation API → `precise_lat/lon`, labeled private). Server stamps `request.cf.city` and computes `ip_match` vs claimed muni as a *signal shown to moderators*, never a rejection rule (rural IPs geolocate badly).

**P4 — reporting:** `GET /api/mod/stats` (grouped counts by day/need/muni/status + median hours pending→verified→resolved). `public/informes.html`: coss-styled, hand-rolled SVG/CSS bar+line charts (repo rule: no runtime deps), date-range filter, print stylesheet so "export" = browser print-to-PDF, plus existing CSV links.

**Ponytail eliminations:** no JWT/session framework (bearer tokens + one hash compare); no chart library (SVG bars); no PDF generator (print CSS); no separate auth service (D1 table); cédula "verification" is possession-check against the registry, not a Registraduría integration (doesn't exist publicly).

## Acceptance criteria
- [ ] P1: admin creates a mod user; that token can verify but cannot open `/api/admin/*` (403); every action (verify/reject/edit/delete/attend/resolve/create/merge) writes a `mod_log` row with actor+role; legacy MOD_TOKEN still works and logs as `legacy-mod`.
- [ ] P2: leader link + correct cédula → request stamped `leader_id`, badge visible in mod queue and `/casos`; wrong cédula or revoked leader → clear rejection, no request; leader identity never appears in public feed/CSV/GeoJSON.
- [ ] P3: form submits with GPS coords → `precise_lat/lon` visible to responders, absent from all public endpoints (PII test extended); moderator card shows "señal: IP Quibdó ≈ municipio ✓/✗"; form works unchanged when geolocation is denied.
- [ ] P4: `/informes` renders totals, by-need, by-muni, time series and median resolution hours matching seeded fixtures; page prints to a legible one-pager.

## Test plan
Extend `tests/pipeline.test.ts` + new `tests/admin.test.ts` (same vitest-pool-workers setup, secrets-free): role matrix (admin/mod/responder/legacy × allowed/denied), audit-log rows per action, leader happy/wrong-cédula/revoked paths, PII boundary re-run over new private columns, stats endpoint against fixtures. Smoke: `npm test`; manual GPS check in preview browser.

## Risks & open questions
- **Cédula is sensitive data (Ley 1581/2012).** Mitigation: hash + last3 only, admin-only visibility, documented in README. → *Confirm you accept storing hash+last3, or drop cédula and gate by link token only.*
- **Open question 1 — exclusivity:** Red Cross phrasing was "leaders are the ones allowed". Recommendation: **hybrid** (open intake stays, leader lane = trust badge + priority), because closing public intake abandons the "remote individual" mission. If they insist, per-muni lockdown could be a config flag later. → *Your call.*
- **Auth expansion risk:** more tokens in more hands. Mitigation: hashes only in D1, revocation UI, audit log covers admin actions too.
- **Open question 2:** legacy MOD_TOKEN/RESPONDER_TOKEN retirement date after P1 lands (recommend: as soon as real users exist).
- **Open question 3:** reporting audience — internal only, or shareable with orgs? (Affects whether `/informes` needs its own read-only role.)

## Rollout / follow-ups
`0002` migration is additive (no breaking change). Ship P1 → P2 → P3 → P4 as separate PRs, each behind green CI. New secret: `ADMIN_TOKEN` (bootstrap). Update README + CONTRIBUTING role docs. Follow-ups deferred: photo upload (R2), full DANE gazetteer (still open), per-org responder tokens (supersedes the shared RESPONDER_TOKEN — folds into P1 naturally).
