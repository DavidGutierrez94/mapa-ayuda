-- Mapa de Ayuda — initial schema
-- Status flow: pending (en revisión) → verified (verificado) | rejected (rechazado)
--              verified → attending (en atención) → resolved (resuelto)

CREATE TABLE raw_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,               -- whatsapp | sms | web | api
  provider_msg_id TEXT NOT NULL,       -- idempotency key: kills webhook-retry duplicates
  sender TEXT,
  body TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(channel, provider_msg_id)
);

CREATE TABLE requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','verified','rejected','attending','resolved')),
  need_type TEXT NOT NULL
    CHECK(need_type IN ('agua','alimentos','medico','rescate','techo','otro')),
  urgency INTEGER NOT NULL DEFAULT 2 CHECK(urgency BETWEEN 1 AND 3),
  description TEXT,
  muni_code TEXT,                      -- DANE code, null if gazetteer missed
  muni_name TEXT,
  dept TEXT,
  lat REAL,                            -- municipality centroid (public-safe)
  lon REAL,
  location_raw TEXT,                   -- what the reporter said, for moderator fixes
  location_detail TEXT,                -- PRIVATE: precise address/vereda, responders only
  households INTEGER NOT NULL DEFAULT 1,
  contact TEXT,                        -- PRIVATE: reporter phone, responders only
  channel TEXT NOT NULL,
  source_org TEXT,                     -- set for api-pushed requests
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_requests_muni ON requests(muni_code, need_type, status);
CREATE INDEX idx_requests_status ON requests(status);

-- "sumarse": one confirmation per phone per request, enforced by the DB
CREATE TABLE confirmations (
  request_id INTEGER NOT NULL REFERENCES requests(id),
  phone TEXT NOT NULL,                 -- PRIVATE, never exposed; only counts are public
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(request_id, phone)
);

-- bot conversation state: a phone we asked "¿quieres sumarte?"
CREATE TABLE pending_actions (
  phone TEXT PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id),
  payload TEXT,                        -- triaged report JSON, so "nueva solicitud" needs no re-triage
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
