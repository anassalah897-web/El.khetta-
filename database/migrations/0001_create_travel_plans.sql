CREATE TABLE IF NOT EXISTS travel_plans (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS travel_plans_updated_at_idx
  ON travel_plans (updated_at DESC);
