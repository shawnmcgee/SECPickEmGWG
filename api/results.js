// /api/results.js
import { sql } from '../lib/db';

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { gameId, homeScore, awayScore, adminPassword } = req.body || await req.json?.() || {};
      
      // Simple password protection (you can make this more secure)
      if (adminPassword !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
      }
      
      if (!gameId || homeScore === undefined || awayScore === undefined) {
        return res.status(400).json({ error: 'gameId, homeScore, and awayScore required' });
      }

      console.log(`Updating result for game ${gameId}: ${awayScore}-${homeScore}`);

      // Insert or update game result
      await sql`
        INSERT INTO results (game_id, home_score, away_score, is_final)
        VALUES (${gameId}, ${Number(homeScore)}, ${Number(awayScore)}, true)
        ON CONFLICT (game_id) 
        DO UPDATE SET 
          home_score = EXCLUDED.home_score,
          away_score = EXCLUDED.away_score,
          is_final = EXCLUDED.is_final,
          updated_at = CURRENT_TIMESTAMP
      `;

      console.log(`Successfully updated result for game ${gameId}`);
      return res.status(200).json({ success: true, message: 'Result updated' });
    }

    if (req.method === 'GET') {
      const { week, gameId } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      
      if (gameId) {
        // Get specific game result
        const [result] = await sql`
          SELECT r.*, g.home_team, g.away_team
          FROM results r
          JOIN games g ON r.game_id = g.id
          WHERE r.game_id = ${gameId}
        `;
        
        return res.status(200).json({ result });
      }
      
      if (week) {
        // Get all results for a week
        const results = await sql`
          SELECT r.*, g.home_team, g.away_team, g.week
          FROM results r
          JOIN games g ON r.game_id = g.id
          WHERE g.week = ${Number(week)}
          ORDER BY g.game_date, g.game_time
        `;
        
        return res.status(200).json({ results });
      }

      // Get all pending games (no results yet)
      const pendingGames = await sql`
        SELECT g.id, g.week, g.home_team, g.away_team, g.game_date, g.game_time
        FROM games g
        LEFT JOIN results r ON g.id = r.game_id
        WHERE r.game_id IS NULL OR r.is_final = false
        ORDER BY g.week, g.game_date, g.game_time
      `;

      return res.status(200).json({ pendingGames });
    }

    if (req.method === 'DELETE') {
      const { gameId, adminPassword } = req.body || await req.json?.() || {};
      
      if (adminPassword !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
      }
      
      if (!gameId) {
        return res.status(400).json({ error: 'gameId required' });
      }

      // Delete game result
      await sql`DELETE FROM results WHERE game_id = ${gameId}`;
      
      return res.status(200).json({ success: true, message: 'Result deleted' });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Results API error:', error);
    return res.status(500).json({ 
      error: 'Server error', 
      detail: error.message 
    });
  }
}
