-- Discord pick reminders.
-- Run this once against the Neon database. Every statement is idempotent, so
-- re-running it is harmless.

-- Opt-in, per player. Defaults to off: nobody gets pinged until they ask for
-- it, and a player who never sets a Discord ID can never be notified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per (player, game) already pinged about. This is what stops a sweep
-- running every 10 minutes from sending the same reminder six times -- the
-- lead window is deliberately wider than the cron interval to absorb GitHub
-- Actions' scheduling drift, so dedupe is doing the real work, not the window.
--
-- The key columns borrow their types from users.id and games.id rather than
-- hardcoding them, so this stays correct whether users.id is INTEGER or BIGINT.
DO $$
DECLARE
  user_id_type TEXT;
  game_id_type TEXT;
BEGIN
  IF to_regclass('public.pick_reminders_sent') IS NOT NULL THEN
    RETURN;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO user_id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.users'::regclass AND a.attname = 'id' AND a.attnum > 0;

  SELECT format_type(a.atttypid, a.atttypmod) INTO game_id_type
  FROM pg_attribute a
  WHERE a.attrelid = 'public.games'::regclass AND a.attname = 'id' AND a.attnum > 0;

  EXECUTE format(
    'CREATE TABLE pick_reminders_sent (
       user_id %s NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       game_id %s NOT NULL REFERENCES games(id) ON DELETE CASCADE,
       sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (user_id, game_id)
     )', user_id_type, game_id_type);
END $$;

CREATE INDEX IF NOT EXISTS pick_reminders_sent_sent_at_idx
  ON pick_reminders_sent (sent_at);
