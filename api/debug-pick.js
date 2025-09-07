// /api/debug-pick.js
import { sql } from '../lib/db';

export default async function handler(req, res) {
  try {
    const { userName, gameId } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    
    if (!userName && !gameId) {
      return res.status(400).json({ error: 'Provide userName or gameId parameter' });
    }

    let debugInfo = {};

    if (gameId) {
      // Get game details
      const [game] = await sql`
        SELECT * FROM games WHERE id = ${gameId}
      `;
      debugInfo.game = game;

      // Get result
      const [result] = await sql`
        SELECT * FROM results WHERE game_id = ${gameId}
      `;
      debugInfo.result = result;

      // Get all picks for this game
      const picks = await sql`
        SELECT p.*, u.name as user_name
        FROM picks p
        JOIN users u ON u.id = p.user_id
        WHERE p.game_id = ${gameId}
      `;
      debugInfo.picks = picks;

      // Calculate who should win
      if (result) {
        debugInfo.calculations = picks.map(pick => {
          const margin = result.home_score - result.away_score;
          let shouldWin = false;
          
          if (pick.pick_type === 'spread') {
            if (pick.selection === game.home_team) {
              // User picked home team
              shouldWin = margin > (-game.spread);
            } else {
              // User picked away team  
              shouldWin = (-margin) > game.spread;
            }
          }
          
          return {
            user: pick.user_name,
            picked: pick.selection,
            spread: game.spread,
            homeScore: result.home_score,
            awayScore: result.away_score,
            margin: margin,
            shouldWin: shouldWin,
            calculation: pick.selection === game.home_team ? 
              `${margin} > ${-game.spread} = ${shouldWin}` :
              `${-margin} > ${game.spread} = ${shouldWin}`
          };
        });
      }
    }

    if (userName) {
      // Get user's picks with game details
      const userPicks = await sql`
        SELECT 
          p.*,
          g.home_team,
          g.away_team,
          g.spread as game_spread,
          g.total as game_total,
          r.home_score,
          r.away_score,
          r.is_final
        FROM picks p
        JOIN users u ON u.id = p.user_id
        JOIN games g ON g.id = p.game_id
        LEFT JOIN results r ON r.game_id = g.id
        WHERE u.name = ${userName}
        AND r.is_final = true
        ORDER BY g.week DESC, g.game_date DESC
      `;
      debugInfo.userPicks = userPicks;
    }

    return res.status(200).json(debugInfo);
    
  } catch (error) {
    console.error('Debug error:', error);
    return res.status(500).json({ 
      error: 'Debug failed',
      detail: error.message 
    });
  }
}
