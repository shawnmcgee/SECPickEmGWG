// /api/standings.js
import { sql } from '../lib/db';
import { SEASON, SCORING_MIN_WEEK, clampWeek, isTestWeek } from '../lib/season';

/*
 * Grading convention
 * ------------------
 * picks.line is stored from the PICKER'S point of view:
 *   picked home -> line = home spread
 *   picked away -> line = away spread (negated home spread)
 *
 * With margin = home_score - away_score:
 *   home pick:  win if margin > -line,  push if margin = -line,  else loss
 *   away pick:  win if margin <  line,  push if margin =  line,  else loss
 *
 * The old query split this into four ABS()-based branches, which produced two
 * real scoring bugs:
 *   1. Pick'em games (line = 0) matched neither the `line < 0` nor `line > 0`
 *      branch, so every winning home pick on a pick'em game scored as a loss.
 *   2. Home underdogs pushed on `margin = ABS(line)` -- a home WIN by N -- when
 *      a home dog actually pushes on a home LOSS by N. Those scored as losses.
 * Both are fixed by the two-case form above.
 */
function gradedRows({ season, week, minWeek }) {
  return sql`
    WITH graded AS (
      SELECT
        u.name,
        g.week,
        CASE
          WHEN r.is_final IS NOT TRUE THEN 'pending'

          WHEN p.pick_type = 'spread' AND p.selection = g.home_team THEN
            CASE
              WHEN (r.home_score - r.away_score) > -p.line THEN 'win'
              WHEN (r.home_score - r.away_score) = -p.line THEN 'push'
              ELSE 'loss'
            END

          WHEN p.pick_type = 'spread' AND p.selection = g.away_team THEN
            CASE
              WHEN (r.home_score - r.away_score) <  p.line THEN 'win'
              WHEN (r.home_score - r.away_score) =  p.line THEN 'push'
              ELSE 'loss'
            END

          WHEN p.pick_type = 'total' THEN
            CASE
              WHEN (r.home_score + r.away_score) = p.line THEN 'push'
              WHEN p.selection = 'over'  AND (r.home_score + r.away_score) > p.line THEN 'win'
              WHEN p.selection = 'under' AND (r.home_score + r.away_score) < p.line THEN 'win'
              ELSE 'loss'
            END

          -- Selection matches neither team (renamed school, stale pick).
          -- Left ungraded on purpose rather than silently counted as a loss.
          ELSE 'ungraded'
        END AS outcome
      FROM picks p
      JOIN users u ON u.id = p.user_id
      JOIN games g ON g.id = p.game_id
      LEFT JOIN results r ON r.game_id = g.id
      WHERE g.season = ${season}
        -- Week filter belongs here, NOT in the JOIN ... ON clause. The old
        -- query put it on the LEFT JOIN, so every other week's picks survived
        -- as NULL rows: total_picks became a season total and every player who
        -- had ever picked showed up in every week at 0-0.
        AND (${week}::int IS NULL OR g.week = ${week}::int)
        -- Week 0 is a test week and never counts toward season standings.
        AND (${minWeek}::int IS NULL OR g.week >= ${minWeek}::int)
    )
    SELECT
      name,
      COUNT(*) FILTER (WHERE outcome = 'win')      AS wins,
      COUNT(*) FILTER (WHERE outcome = 'loss')     AS losses,
      COUNT(*) FILTER (WHERE outcome = 'push')     AS pushes,
      COUNT(*) FILTER (WHERE outcome = 'pending')  AS pending,
      COUNT(*) FILTER (WHERE outcome = 'ungraded') AS ungraded,
      COUNT(*)                                     AS total_picks
    FROM graded
    GROUP BY name
    ORDER BY wins DESC, losses ASC, pushes DESC, name ASC
  `;
}

function format(rows) {
  return rows.map((r) => {
    const wins = Number(r.wins) || 0;
    const losses = Number(r.losses) || 0;
    const pushes = Number(r.pushes) || 0;
    const decided = wins + losses;
    return {
      name: r.name,
      wins,
      losses,
      pushes,
      pending: Number(r.pending) || 0,
      ungraded: Number(r.ungraded) || 0,
      totalPicks: Number(r.total_picks) || 0,
      winPercentage: decided > 0 ? Math.round((wins / decided) * 100) : 0,
      record: `${wins}-${losses}${pushes > 0 ? `-${pushes}` : ''}`,
    };
  });
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const url = new URL(req.url, 'http://x');
    const weekParam = url.searchParams.get('week');
    const seasonParam = Number(url.searchParams.get('seasonYear')) || SEASON;

    // Week scope when ?week=N is present; season scope otherwise.
    // (?season=true from the old frontend has no week, so it lands here too.)
    const isSeasonScope = weekParam === null || weekParam === '';
    const week = isSeasonScope ? null : clampWeek(weekParam);

    const rows = await gradedRows({
      season: seasonParam,
      week,
      // Season totals skip the test week. A direct request for week 0 still
      // returns its standings so you can confirm grading works end to end.
      minWeek: isSeasonScope ? SCORING_MIN_WEEK : null,
    });

    return res.status(200).json({
      standings: format(rows),
      scope: isSeasonScope ? 'season' : 'week',
      season: seasonParam,
      week,
      testWeek: week !== null && isTestWeek(week),
      countsTowardSeason: week === null ? true : !isTestWeek(week),
    });
  } catch (error) {
    console.error('Standings API error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}
