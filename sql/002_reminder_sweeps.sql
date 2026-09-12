-- Tracks when the reminder sweep last actually ran.
--
-- GitHub Actions silently drops most high-frequency scheduled firings: a
-- */10 schedule was observed producing three runs in eight hours, with gaps of
-- 250 and 215 minutes. A fixed 75-minute lead window assumes the sweep runs
-- far more often than the window is wide; when it does not, games lock
-- unpinged between sweeps.
--
-- Recording each real sweep lets the endpoint measure its own cadence and
-- widen the window to cover the gap it actually observes, so a dropped
-- schedule delays a reminder rather than losing it.
--
-- Run once. Idempotent.
CREATE TABLE IF NOT EXISTS reminder_sweeps (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at  TIMESTAMPTZ NOT NULL
);
