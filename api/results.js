// /api/results.js
import { sql } from '../lib/db';
import { SEASON, clampWeek } from '../lib/season';

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

/**
 * If ADMIN_PASSWORD is unset, `adminPassword !== process.env.ADMIN_PASSWORD`
 * compares undefined to undefined, returns false, and lets a request with no
 * password straight through. The first clause closes that.
 */
function checkAdmin(adminPassword) {
  if (!process.env.ADMIN_PASSWORD) return 'Admin password is not configured on the server';
  if (adminPassword !== process.env.ADMIN_PASSWORD) return 'Invalid admin password';
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { gameId, homeScore, awayScore, adminPassword } = readBody(req);

      const authError = checkAdmin(adminPassword);
      if (authError) return res.status(401).json({ error: authError });

      if (!gameId || homeScore === undefined || awayScore === undefined) {
        return res.status(400).json({ error: 'gameId, homeScore, and awayScore required' });
      }
      const h = Number(homeScore);
      const a = Number(awayScore);
      if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0) {
        return res.status(400).json({ error: 'Scores must be non-negative numbers' });
      }

      await sql`
        INSERT INTO results (game_id, home_score, away_score, is_final)
        VALUES (${gameId}, ${h}, ${a}, true)
        ON CONFLICT (game_id) DO UPDATE SET
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          is_final   = EXCLUDED.is_final,
          updated_at = CURRENT_TIMESTAMP
      `;
      return res.status(200).json({ success: true, message: 'Result updated' });
    }

    if (req.method === 'GET') {
      const params = new URL(req.url, 'http://x').searchParams;
      const gameId = params.get('gameId');
      const weekParam = params.get('week');
      const season = Number(params.get('seasonYear')) || SEASON;

      if (gameId) {
        const [result] = await sql`
          SELECT r.*, g.home_team, g.away_team
          FROM results r JOIN games g ON g.id = r.game_id
          WHERE r.game_id = ${gameId}
        `;
        return res.status(200).json({ result: result || null });
      }

      if (weekParam !== null && weekParam !== '') {
        const week = clampWeek(weekParam);
        const results = await sql`
          SELECT r.*, g.home_team, g.away_team, g.week
          FROM results r JOIN games g ON g.id = r.game_id
          WHERE g.week = ${week} AND g.season = ${season}
          ORDER BY g.kickoff_at NULLS LAST, g.game_date, g.game_time
        `;
        return res.status(200).json({ results });
      }

      // Games still awaiting a final, current season only.
      const pendingGames = await sql`
        SELECT g.id, g.week, g.home_team, g.away_team, g.game_date, g.game_time, g.kickoff_at
        FROM games g
        LEFT JOIN results r ON r.game_id = g.id
        WHERE g.season = ${season} AND (r.game_id IS NULL OR r.is_final = false)
        ORDER BY g.week, g.kickoff_at NULLS LAST
      `;
      return res.status(200).json({ pendingGames });
    }

    if (req.method === 'DELETE') {
      const { gameId, adminPassword } = readBody(req);
      const authError = checkAdmin(adminPassword);
      if (authError) return res.status(401).json({ error: authError });
      if (!gameId) return res.status(400).json({ error: 'gameId required' });

      await sql`DELETE FROM results WHERE game_id = ${gameId}`;
      return res.status(200).json({ success: true, message: 'Result deleted' });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Results API error:', error);
    // Previously returned error.message, exposing driver and schema internals.
    return res.status(500).json({ error: 'Server error' });
  }
}
