CREATE TABLE IF NOT EXISTS travel_plans (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS travel_plans_updated_at_idx
  ON travel_plans (updated_at DESC);
