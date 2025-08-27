// /api/picks.js
import { sql } from '../lib/db';

export default async function handler(req, res) {
  if (!sql) {
    return res.status(500).json({ 
      error: 'Database not configured',
      detail: 'Missing DATABASE_URL or @neondatabase/serverless package'
    });
  }

async function ensureGameExists(gameData) {
  // Insert game if it doesn't exist
  await sql`
    INSERT INTO games (id, week, home_team, away_team, spread, total, game_date, game_time, 
                      is_over_under, is_sec_matchup, original_home_team, original_away_team)
    VALUES (${gameData.id}, ${gameData.week}, ${gameData.home}, ${gameData.away}, 
            ${gameData.spread}, ${gameData.total}, ${gameData.date}, ${gameData.time},
            ${gameData.isOverUnder}, ${gameData.isSecMatchup}, 
            ${gameData.originalHomeTeam || gameData.home}, ${gameData.originalAwayTeam || gameData.away})
    ON CONFLICT (id) DO UPDATE SET
      spread = EXCLUDED.spread,
      total = EXCLUDED.total,
      game_date = EXCLUDED.game_date,
      game_time = EXCLUDED.game_time
  `;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { userName, week, picks, games } = req.body || await req.json?.() || {};
      
      if (!userName || !Array.isArray(picks) || !week) {
        return res.status(400).json({ error: 'userName, week, and picks required' });
      }

      console.log(`Saving picks for user: ${userName}, week: ${week}, picks count: ${picks.length}`);

      // Upsert user
      const [{ id: user_id }] = await sql`
        INSERT INTO users (name)
        VALUES (${userName})
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;

      console.log(`User ID: ${user_id}`);

      // Ensure games exist in the database if games data provided
      if (games && Array.isArray(games)) {
        console.log(`Ensuring ${games.length} games exist in database`);
        for (const game of games) {
          await ensureGameExists({
            ...game,
            week: parseInt(week)
          });
        }
      }

      // Insert/update picks
      for (const pick of picks) {
        const { gameId, selection } = pick;
        
        // Determine pick type and line based on selection
        let pickType, line;
        
        if (selection === 'over' || selection === 'under') {
          pickType = 'total';
          // Get the total from the games data or database
          if (games) {
            const game = games.find(g => g.id === gameId);
            line = game ? game.total : 50;
          } else {
            // Get from database
            const [gameResult] = await sql`SELECT total FROM games WHERE id = ${gameId}`;
            line = gameResult ? gameResult.total : 50;
          }
        } else {
          pickType = 'spread';
          // Get the spread from the games data or database
          if (games) {
            const game = games.find(g => g.id === gameId);
            if (game) {
              // Determine which spread to use based on selection
              line = selection === game.home ? game.spread : -game.spread;
            } else {
              line = 0;
            }
          } else {
            // Get from database
            const [gameResult] = await sql`SELECT spread, home_team FROM games WHERE id = ${gameId}`;
            if (gameResult) {
              line = selection === gameResult.home_team ? gameResult.spread : -gameResult.spread;
            } else {
              line = 0;
            }
          }
        }

        console.log(`Inserting pick: User ${user_id}, Game ${gameId}, Type ${pickType}, Selection ${selection}, Line ${line}`);

        await sql`
          INSERT INTO picks (user_id, game_id, pick_type, selection, line)
          VALUES (${user_id}, ${gameId}, ${pickType}, ${selection}, ${line})
          ON CONFLICT (user_id, game_id)
          DO UPDATE SET 
            pick_type = EXCLUDED.pick_type,
            selection = EXCLUDED.selection,
            line = EXCLUDED.line
        `;
      }

      console.log(`Successfully saved ${picks.length} picks for user ${userName}`);
      return res.status(200).json({ success: true, message: `Saved ${picks.length} picks` });
    }

    if (req.method === 'GET') {
      const { userName, week } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      
      if (!userName || !week) {
        return res.status(400).json({ error: 'userName and week required' });
      }

      console.log(`Retrieving picks for user: ${userName}, week: ${week}`);

      const picks = await sql`
        SELECT p.game_id, p.pick_type, p.selection, p.line
        FROM picks p
        JOIN users u ON u.id = p.user_id
        JOIN games g ON g.id = p.game_id
        WHERE u.name = ${userName} AND g.week = ${Number(week)}
      `;

      console.log(`Found ${picks.length} picks for user ${userName} in week ${week}`);
      
      // Convert to the format expected by frontend
      const picksMap = {};
      picks.forEach(pick => {
        picksMap[pick.game_id] = pick.selection;
      });

      return res.status(200).json({ picks: picksMap });
    }

    if (req.method === 'DELETE') {
      // Delete user and all their picks
      const { userName } = req.body || await req.json?.() || {};
      
      if (!userName) {
        return res.status(400).json({ error: 'userName required' });
      }

      console.log(`Deleting user: ${userName}`);

      // Get user ID first
      const [user] = await sql`SELECT id FROM users WHERE name = ${userName}`;
      
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Delete picks first (foreign key constraint)
      await sql`DELETE FROM picks WHERE user_id = ${user.id}`;
      
      // Delete user
      await sql`DELETE FROM users WHERE id = ${user.id}`;

      console.log(`Successfully deleted user ${userName} and all their picks`);
      return res.status(200).json({ success: true, message: `Deleted user ${userName}` });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Picks API error:', error);
    return res.status(500).json({ 
      error: 'Server error', 
      detail: error.message,
      stack: error.stack 
    });
  }
}
