// /api/games-history.js
import { sql } from '../lib/db';

export default async function handler(req, res) {
  try {
    const { week } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    
    if (!week) {
      return res.status(400).json({ error: 'Week parameter required' });
    }

    // Get all games for the week that have been saved to the database
    const games = await sql`
      SELECT DISTINCT 
        id, 
        week, 
        home_team, 
        away_team, 
        spread, 
        total, 
        game_date, 
        game_time,
        is_over_under,
        is_sec_matchup,
        original_home_team,
        original_away_team
      FROM games 
      WHERE week = ${Number(week)}
      ORDER BY game_date, game_time
    `;

    // Format games to match frontend structure
    const formattedGames = games.map(g => ({
      id: g.id,
      home: g.home_team,
      away: g.away_team,
      spread: parseFloat(g.spread),
      total: parseFloat(g.total),
      date: g.game_date,
      time: g.game_time,
      isOverUnder: g.is_over_under,
      isSecMatchup: g.is_sec_matchup,
      originalHomeTeam: g.original_home_team,
      originalAwayTeam: g.original_away_team
    }));

    return res.status(200).json({ 
      games: formattedGames,
      source: 'database',
      week: Number(week)
    });
    
  } catch (error) {
    console.error('Games history error:', error);
    return res.status(500).json({ 
      error: 'Failed to load game history',
      detail: error.message 
    });
  }
}
