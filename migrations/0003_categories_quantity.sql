-- New need categories (higiene, infancia) + quantity field.
-- SQLite cannot alter a CHECK constraint, so requests is rebuilt without the
-- need_type CHECK: valid categories are enforced in the API from the single
-- NEED_TYPES list (src/index.ts), making future category additions code-only.

CREATE TABLE requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','verified','rejected','attending','resolved')),
  need_type TEXT NOT NULL,
  urgency INTEGER NOT NULL DEFAULT 2 CHECK(urgency BETWEEN 1 AND 3),
  description TEXT,
  muni_code TEXT,
  muni_name TEXT,
  dept TEXT,
  lat REAL,
  lon REAL,
  location_raw TEXT,
  location_detail TEXT,
  households INTEGER NOT NULL DEFAULT 1,
  contact TEXT,
  channel TEXT NOT NULL,
  source_org TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  leader_id INTEGER REFERENCES leaders(id),
  reporter_name TEXT,
  people_count INTEGER,
  vulnerable TEXT,
  access_note TEXT,
  precise_lat REAL,
  precise_lon REAL,
  ip_city TEXT,
  ip_match INTEGER,
  quantity TEXT                        -- free text: "20 mercados", "100 litros de agua"
);

INSERT INTO requests_new (id, status, need_type, urgency, description, muni_code, muni_name,
  dept, lat, lon, location_raw, location_detail, households, contact, channel, source_org,
  created_at, updated_at, leader_id, reporter_name, people_count, vulnerable, access_note,
  precise_lat, precise_lon, ip_city, ip_match)
SELECT id, status, need_type, urgency, description, muni_code, muni_name,
  dept, lat, lon, location_raw, location_detail, households, contact, channel, source_org,
  created_at, updated_at, leader_id, reporter_name, people_count, vulnerable, access_note,
  precise_lat, precise_lon, ip_city, ip_match
FROM requests;

DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;
CREATE INDEX idx_requests_muni ON requests(muni_code, need_type, status);
CREATE INDEX idx_requests_status ON requests(status);
