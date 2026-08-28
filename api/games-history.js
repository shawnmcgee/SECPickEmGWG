// /api/games-history.js
import { sql } from '../lib/db';
import { SEASON, clampWeek, isTestWeek } from '../lib/season';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const url = new URL(req.url, 'http://x');
    const weekParam = url.searchParams.get('week');
    if (!weekParam) return res.status(400).json({ error: 'week parameter required' });

    const week = clampWeek(weekParam);
    const season = Number(url.searchParams.get('season')) || SEASON;

    // Without the season filter this returned last year's games for the same
    // week number, since week is not unique across seasons.
    const games = await sql`
      SELECT g.id, g.season, g.week, g.home_team, g.away_team, g.spread, g.total,
             g.game_date, g.game_time, g.kickoff_at,
             g.is_over_under, g.is_sec_matchup,
             g.original_home_team, g.original_away_team,
             r.home_score, r.away_score, r.is_final,
             (g.kickoff_at IS NOT NULL AND g.kickoff_at <= NOW()) AS locked
      FROM games g
      LEFT JOIN results r ON r.game_id = g.id
      WHERE g.week = ${week} AND g.season = ${season}
      ORDER BY g.kickoff_at NULLS LAST, g.game_date, g.game_time
    `;

    return res.status(200).json({
      season,
      week,
      testWeek: isTestWeek(week),
      source: 'database',
      games: games.map((g) => ({
        id: g.id,
        home: g.home_team,
        away: g.away_team,
        spread: parseFloat(g.spread),
        total: parseFloat(g.total),
        date: g.game_date,
        time: g.game_time,
        kickoffAt: g.kickoff_at,
        locked: g.locked,
        isOverUnder: g.is_over_under,
        isSecMatchup: g.is_sec_matchup,
        originalHomeTeam: g.original_home_team,
        originalAwayTeam: g.original_away_team,
        // Lets the UI render FINAL badges and lock picks -- the old frontend
        // had a `gameResults` object it read from but never populated.
        result: g.is_final
          ? { homeScore: g.home_score, awayScore: g.away_score, completed: true }
          : null,
      })),
    });
  } catch (error) {
    console.error('Games history error:', error);
    return res.status(500).json({ error: 'Failed to load game history' });
  }
}
