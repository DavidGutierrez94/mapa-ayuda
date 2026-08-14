-- v2 (PRD: docs/prd/v2-redcross-feedback.md)
-- P1: named users with roles + audit log. P2/P3 columns added here too so the
-- schema ships once; they stay unused until their phase lands.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','mod','responder')),
  token_hash TEXT NOT NULL UNIQUE,     -- SHA-256 of the bearer token; raw token shown once at creation
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE leaders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  muni_code TEXT,
  cedula_hash TEXT,                    -- SHA-256; raw cédula is never stored (Ley 1581 minimization)
  cedula_last3 TEXT,
  link_token TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE mod_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id INTEGER,
  detail TEXT,                         -- JSON: the acted-on payload
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_mod_log_request ON mod_log(request_id);

-- P2/P3 request fields. precise_*, ip_* and leader identity are PRIVATE
-- (mod/responder views only; never selected by public endpoints).
ALTER TABLE requests ADD COLUMN leader_id INTEGER REFERENCES leaders(id);
ALTER TABLE requests ADD COLUMN reporter_name TEXT;
ALTER TABLE requests ADD COLUMN people_count INTEGER;
ALTER TABLE requests ADD COLUMN vulnerable TEXT;
ALTER TABLE requests ADD COLUMN access_note TEXT;
ALTER TABLE requests ADD COLUMN precise_lat REAL;
ALTER TABLE requests ADD COLUMN precise_lon REAL;
ALTER TABLE requests ADD COLUMN ip_city TEXT;
ALTER TABLE requests ADD COLUMN ip_match INTEGER;
