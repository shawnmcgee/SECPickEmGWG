// /api/picks.js
import { sql } from '../lib/db';

async function ensureGameExists(gameData) {
  try {
    // Insert game if it doesn't exist
    await sql`
      INSERT INTO games (id, week, home_team, away_team, spread, total, game_date, game_time, 
                        is_over_under, is_sec_matchup, original_home_team, original_away_team)
      VALUES (${gameData.id}, ${gameData.week}, ${gameData.home}, ${gameData.away}, 
              ${gameData.spread}, ${gameData.total}, ${gameData.date}, ${gameData.time},
              ${gameData.isOverUnder || false}, ${gameData.isSecMatchup || false}, 
              ${gameData.originalHomeTeam || gameData.home}, ${gameData.originalAwayTeam || gameData.away})
      ON CONFLICT (id) DO UPDATE SET
        spread = EXCLUDED.spread,
        total = EXCLUDED.total,
        game_date = EXCLUDED.game_date,
        game_time = EXCLUDED.game_time
    `;
  } catch (error) {
    console.error('Error ensuring game exists:', error);
    throw error;
  }
}

export default async function handler(req, res) {
  // Log incoming request for debugging
  console.log('Picks API called:', req.method);
  
  try {
    if (req.method === 'POST') {
      // Parse the body
      let body;
      if (typeof req.body === 'string') {
        body = JSON.parse(req.body);
      } else {
        body = req.body;
      }
      
      const { userName, week, picks, games } = body;
      
      console.log('Processing picks for:', { userName, week, picksCount: picks?.length });
      
      if (!userName || !Array.isArray(picks) || !week) {
        return res.status(400).json({ error: 'userName, week, and picks required' });
      }

      // Upsert user
      let user_id;
      try {
        const userResult = await sql`
          INSERT INTO users (name)
          VALUES (${userName})
          ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
          RETURNING id
        `;
        user_id = userResult[0].id;
        console.log(`User ID: ${user_id}`);
      } catch (error) {
        console.error('Error creating/finding user:', error);
        return res.status(500).json({ 
          error: 'Failed to create/find user', 
          detail: error.message 
        });
      }

      // Ensure games exist in the database if games data provided
      if (games && Array.isArray(games)) {
        console.log(`Ensuring ${games.length} games exist in database`);
        for (const game of games) {
          try {
            await ensureGameExists({
              ...game,
              week: parseInt(week)
            });
          } catch (error) {
            console.error(`Failed to ensure game ${game.id} exists:`, error);
            // Continue with other games even if one fails
          }
        }
      }

      // Insert/update picks
      let successCount = 0;
      for (const pick of picks) {
        try {
          const { gameId, selection } = pick;
          
          // Determine pick type and line based on selection
          let pickType, line;
          
          if (selection === 'over' || selection === 'under') {
            pickType = 'total';
            // Get the total from the games data
            if (games) {
              const game = games.find(g => g.id === gameId);
              line = game ? game.total : 50;
            } else {
              line = 50;
            }
          } else {
            pickType = 'spread';
            // Get the spread from the games data
            if (games) {
              const game = games.find(g => g.id === gameId);
              if (game) {
                line = selection === game.home ? game.spread : -game.spread;
              } else {
                line = 0;
              }
            } else {
              line = 0;
            }
          }

          await sql`
            INSERT INTO picks (user_id, game_id, pick_type, selection, line)
            VALUES (${user_id}, ${gameId}, ${pickType}, ${selection}, ${line})
            ON CONFLICT (user_id, game_id)
            DO UPDATE SET 
              pick_type = EXCLUDED.pick_type,
              selection = EXCLUDED.selection,
              line = EXCLUDED.line
          `;
          successCount++;
        } catch (error) {
          console.error(`Failed to save pick for game ${pick.gameId}:`, error);
        }
      }

      console.log(`Successfully saved ${successCount} of ${picks.length} picks for user ${userName}`);
      return res.status(200).json({ 
        success: true, 
        message: `Saved ${successCount} of ${picks.length} picks` 
      });
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
      let body;
      if (typeof req.body === 'string') {
        body = JSON.parse(req.body);
      } else {
        body = req.body;
      }
      
      const { userName, adminPassword } = body;
      
      // Check admin password
      if (adminPassword !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
      }
      
      if (!userName) {
        return res.status(400).json({ error: 'userName required' });
      }

      console.log(`Deleting user: ${userName}`);

      // Get user ID first
      const userResult = await sql`SELECT id FROM users WHERE name = ${userName}`;
      
      if (!userResult || userResult.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult[0];

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
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
