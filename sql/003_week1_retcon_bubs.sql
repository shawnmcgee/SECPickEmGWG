-- ---------------------------------------------------------------------------
-- Week 1 retcon: restore Bubs' two unsaved picks.
--
-- WHY THIS EXISTS
-- Bubs made two Week 1 picks in the UI on Sat Sep 5 2026 and never hit Save,
-- so no `picks` rows were ever written. The league agreed to honour them.
--
-- WHAT IT DOES *NOT* DO
-- It does not fabricate a win. Standings are derived, not stored: api/standings.js
-- grades `picks` against `results` on every request, and there is no wins column
-- anywhere. All this script asserts is "Bubs picked these two sides". The wins
-- fall out of the real final scores:
--
--   Alabama -28.5 (home) vs East Carolina .... 48-10, won by 38  -> covers
--   Over 54.5, Kent State at South Carolina .. 0-57, total 57    -> over
--
-- Both clear their line with room to spare, so `results` is untouched. Editing
-- a result would regrade that game for every other player in the league.
--
-- The script refuses to leave behind anything that is not a win: it re-grades
-- its own inserts with the exact expression from api/standings.js and raises
-- (rolling back the whole DO block) if either row comes back anything but
-- 'win'. It cannot be used to quietly plant a loss or a push.
--
-- Idempotent, matching 001/002. Re-running inserts nothing.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_user   users.id%TYPE;
  v_added  INT := 0;
  v_row    RECORD;
  v_bad    INT := 0;

  -- The player, exactly as stored in users.name.
  c_name   TEXT := 'Bubs';

  -- Game ids.
  c_bama   TEXT := 'b10ebab18213ecdc575885bfa874b98d';  -- East Carolina at Alabama
  c_sc     TEXT := '994c7280c9e8dcb041c260eb2c767d4d';  -- Kent State at South Carolina

  -- The lines to lock these picks at.
  --
  -- READ THIS BEFORE RUNNING. picks.line is what standings score against AND what
  -- the card renders as "Locked at" (app.js lockedNote reads picks.line directly).
  -- These are the pick-time lines from the submitted screenshot, NOT the current
  -- games.spread / games.total, which are the kickoff-frozen closing numbers
  -- (-27.5 and 53.5 -- games.spread stops updating at kickoff, see api/games.js).
  --
  -- Both choices grade identically here, so this is presentation, not outcome.
  -- The pick-time numbers are the harder side of both markets (-28.5 is more to
  -- cover than -27.5; over 54.5 is more to clear than 53.5), so Bubs is not being
  -- handed a softer line than he would have had. His card will show the same
  -- "line moved" note every other player's does.
  c_bama_line NUMERIC := -28.5;  -- Alabama is home, so this is games.spread's sign
  c_sc_line   NUMERIC :=  54.5;
BEGIN
  SELECT id INTO v_user FROM users WHERE name = c_name;
  IF v_user IS NULL THEN
    RAISE EXCEPTION
      'No users row named %. Check the exact stored spelling before re-running.', c_name;
  END IF;

  -- Both games must really be Week 1 of this season and really be final.
  -- Guards against a typo'd id silently matching nothing.
  PERFORM 1
  FROM games g
  JOIN results r ON r.game_id = g.id AND r.is_final IS TRUE
  WHERE g.id = c_bama AND g.season = 2026 AND g.week = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Alabama game % is not a final Week 1 2026 game.', c_bama;
  END IF;

  PERFORM 1
  FROM games g
  JOIN results r ON r.game_id = g.id AND r.is_final IS TRUE
  WHERE g.id = c_sc AND g.season = 2026 AND g.week = 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'South Carolina game % is not a final Week 1 2026 game.', c_sc;
  END IF;

  -- Alabama on the spread. The CASE mirrors api/picks.js: picks.line is stored
  -- from the picker's point of view, so a home pick keeps the sign and an away
  -- pick negates it.
  INSERT INTO picks (user_id, game_id, pick_type, selection, line)
  SELECT v_user, g.id, 'spread', 'Alabama',
         CASE WHEN g.home_team = 'Alabama' THEN c_bama_line ELSE -c_bama_line END
  FROM games g
  WHERE g.id = c_bama
  ON CONFLICT (user_id, game_id) DO NOTHING;   -- never clobber a real pick
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RAISE NOTICE 'Alabama spread: % row(s) inserted.', v_added;

  -- South Carolina over. South Carolina is in OU_ONLY_TEAMS (lib/season.js), so
  -- a total is the only legal pick shape on this game.
  INSERT INTO picks (user_id, game_id, pick_type, selection, line)
  SELECT v_user, g.id, 'total', 'over', c_sc_line
  FROM games g
  WHERE g.id = c_sc
  ON CONFLICT (user_id, game_id) DO NOTHING;
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RAISE NOTICE 'South Carolina over: % row(s) inserted.', v_added;

  -- ---------------------------------------------------------------------
  -- Re-grade what is now actually in the table, using the expression from
  -- api/standings.js verbatim. Anything that is not a win aborts the whole
  -- block and rolls the inserts back.
  -- ---------------------------------------------------------------------
  FOR v_row IN
    SELECT g.id,
           g.away_team || ' at ' || g.home_team AS matchup,
           p.selection, p.line,
           r.away_score || '-' || r.home_score AS score,
           CASE
             WHEN r.is_final IS NOT TRUE THEN 'pending'
             WHEN p.pick_type = 'spread' AND p.selection = g.home_team THEN
               CASE WHEN (r.home_score - r.away_score) > -p.line THEN 'win'
                    WHEN (r.home_score - r.away_score) = -p.line THEN 'push'
                    ELSE 'loss' END
             WHEN p.pick_type = 'spread' AND p.selection = g.away_team THEN
               CASE WHEN (r.home_score - r.away_score) <  p.line THEN 'win'
                    WHEN (r.home_score - r.away_score) =  p.line THEN 'push'
                    ELSE 'loss' END
             WHEN p.pick_type = 'total' THEN
               CASE WHEN (r.home_score + r.away_score) = p.line THEN 'push'
                    WHEN p.selection = 'over'  AND (r.home_score + r.away_score) > p.line THEN 'win'
                    WHEN p.selection = 'under' AND (r.home_score + r.away_score) < p.line THEN 'win'
                    ELSE 'loss' END
             ELSE 'ungraded'
           END AS outcome
    FROM picks p
    JOIN users u   ON u.id = p.user_id
    JOIN games g   ON g.id = p.game_id
    LEFT JOIN results r ON r.game_id = g.id
    WHERE u.id = v_user AND p.game_id IN (c_bama, c_sc)
  LOOP
    RAISE NOTICE '% | % % | % | %',
      v_row.matchup, v_row.selection, v_row.line, v_row.score, upper(v_row.outcome);
    IF v_row.outcome <> 'win' THEN
      v_bad := v_bad + 1;
    END IF;
  END LOOP;

  IF v_bad > 0 THEN
    RAISE EXCEPTION
      '% pick(s) did not grade as a win. Rolled back -- nothing was changed.', v_bad;
  END IF;

  RAISE NOTICE 'Both picks grade as wins. Committing.';
END $$;

-- Bubs' season record after the retcon, same scope the standings page uses
-- (season 2026, week >= SCORING_MIN_WEEK).
SELECT
  COUNT(*) FILTER (WHERE outcome = 'win')  AS wins,
  COUNT(*) FILTER (WHERE outcome = 'loss') AS losses,
  COUNT(*) FILTER (WHERE outcome = 'push') AS pushes
FROM (
  SELECT
    CASE
      WHEN r.is_final IS NOT TRUE THEN 'pending'
      WHEN p.pick_type = 'spread' AND p.selection = g.home_team THEN
        CASE WHEN (r.home_score - r.away_score) > -p.line THEN 'win'
             WHEN (r.home_score - r.away_score) = -p.line THEN 'push' ELSE 'loss' END
      WHEN p.pick_type = 'spread' AND p.selection = g.away_team THEN
        CASE WHEN (r.home_score - r.away_score) <  p.line THEN 'win'
             WHEN (r.home_score - r.away_score) =  p.line THEN 'push' ELSE 'loss' END
      WHEN p.pick_type = 'total' THEN
        CASE WHEN (r.home_score + r.away_score) = p.line THEN 'push'
             WHEN p.selection = 'over'  AND (r.home_score + r.away_score) > p.line THEN 'win'
             WHEN p.selection = 'under' AND (r.home_score + r.away_score) < p.line THEN 'win'
             ELSE 'loss' END
      ELSE 'ungraded'
    END AS outcome
  FROM picks p
  JOIN users u ON u.id = p.user_id
  JOIN games g ON g.id = p.game_id
  LEFT JOIN results r ON r.game_id = g.id
  WHERE u.name = 'Bubs' AND g.season = 2026 AND g.week >= 1
) graded;
