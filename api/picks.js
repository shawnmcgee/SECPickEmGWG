// /api/picks.js
import { sql } from '../lib/db';
import { SEASON, clampWeek, isTestWeek } from '../lib/season';

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

export default async function handler(req, res) {
  try {
    /* ------------------------------------------------------------------ */
    if (req.method === 'POST') {
      const { userName, week: rawWeek, picks } = readBody(req);

      // `!rawWeek` would reject week 0 -- the test week arrives as the JSON
      // number 0, which is falsy. Check for actually-absent instead.
      const weekMissing = rawWeek === undefined || rawWeek === null || rawWeek === '';
      if (!userName || weekMissing || !Array.isArray(picks) || picks.length === 0) {
        return res.status(400).json({ error: 'userName, week, and picks required' });
      }
      if (!Number.isFinite(Number(rawWeek))) {
        return res.status(400).json({ error: 'week must be a number' });
      }
      const week = clampWeek(rawWeek);
      const name = String(userName).trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: 'userName required' });

      // The client no longer supplies game data. Lines come from the games
      // table, which only /api/games writes. Previously the client posted its
      // own `games` array, which meant any player could rewrite the spread of
      // any game for everyone -- and a stale phone cache could silently
      // overwrite current lines just by submitting picks.
      const gameIds = picks.map((p) => p.gameId).filter(Boolean);
      if (gameIds.length === 0) {
        return res.status(400).json({ error: 'No valid gameId values in picks' });
      }

      const games = await sql`
        SELECT id, home_team, away_team, spread, total, is_over_under, kickoff_at,
               (kickoff_at IS NOT NULL AND kickoff_at <= NOW()) AS locked
        FROM games
        WHERE id = ANY(${gameIds}) AND season = ${SEASON} AND week = ${week}
      `;
      const gameById = new Map(games.map((g) => [g.id, g]));

      const [user] = await sql`
        INSERT INTO users (name) VALUES (${name})
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;

      const saved = [];
      const rejected = [];

      for (const pick of picks) {
        const game = gameById.get(pick.gameId);
        if (!game) {
          rejected.push({ gameId: pick.gameId, reason: 'unknown game for this week' });
          continue;
        }
        // Server-side deadline. Without this, picks stayed editable after the
        // final whistle.
        if (game.locked) {
          rejected.push({ gameId: pick.gameId, reason: 'kickoff has passed' });
          continue;
        }

        const selection = String(pick.selection);
        let pickType;
        let line;

        if (selection === 'over' || selection === 'under') {
          pickType = 'total';
          line = Number(game.total);
        } else if (selection === game.home_team) {
          if (game.is_over_under) {
            rejected.push({ gameId: pick.gameId, reason: 'this game is over/under only' });
            continue;
          }
          pickType = 'spread';
          line = Number(game.spread);
        } else if (selection === game.away_team) {
          if (game.is_over_under) {
            rejected.push({ gameId: pick.gameId, reason: 'this game is over/under only' });
            continue;
          }
          pickType = 'spread';
          line = -Number(game.spread);
        } else {
          rejected.push({ gameId: pick.gameId, reason: 'selection does not match either team' });
          continue;
        }

        try {
          await sql`
            INSERT INTO picks (user_id, game_id, pick_type, selection, line)
            VALUES (${user.id}, ${game.id}, ${pickType}, ${selection}, ${line})
            ON CONFLICT (user_id, game_id) DO UPDATE SET
              pick_type = EXCLUDED.pick_type,
              selection = EXCLUDED.selection,
              line      = EXCLUDED.line
          `;
          saved.push(game.id);
        } catch (e) {
          console.error(`Failed to save pick ${game.id}:`, e.message);
          rejected.push({ gameId: pick.gameId, reason: 'database error' });
        }
      }

      return res.status(200).json({
        success: true,
        saved: saved.length,
        rejected,
        testWeek: isTestWeek(week),
        message: `Saved ${saved.length} of ${picks.length} picks`,
      });
    }

    /* ------------------------------------------------------------------ */
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const userName = url.searchParams.get('userName');
      const weekParam = url.searchParams.get('week');
      if (!userName || !weekParam) {
        return res.status(400).json({ error: 'userName and week required' });
      }
      const week = clampWeek(weekParam);

      const rows = await sql`
        SELECT p.game_id, p.pick_type, p.selection, p.line,
               (g.kickoff_at IS NOT NULL AND g.kickoff_at <= NOW()) AS locked
        FROM picks p
        JOIN users u ON u.id = p.user_id
        JOIN games g ON g.id = p.game_id
        WHERE u.name = ${userName} AND g.week = ${week} AND g.season = ${SEASON}
      `;

      const picksMap = {};
      const locked = {};
      // The line each pick was saved at. Grading uses picks.line, not the
      // current games.spread, so the client needs this to show players the
      // number they will actually be scored against.
      const lines = {};
      rows.forEach((r) => {
        picksMap[r.game_id] = r.selection;
        locked[r.game_id] = r.locked;
        lines[r.game_id] = r.line === null ? null : Number(r.line);
      });

      return res.status(200).json({ picks: picksMap, locked, lines });
    }

    /* ------------------------------------------------------------------ */
    if (req.method === 'DELETE') {
      const { userName, adminPassword } = readBody(req);
      if (!process.env.ADMIN_PASSWORD || adminPassword !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid admin password' });
      }
      if (!userName) return res.status(400).json({ error: 'userName required' });

      const [user] = await sql`SELECT id FROM users WHERE name = ${userName}`;
      if (!user) return res.status(404).json({ error: 'User not found' });

      await sql`DELETE FROM picks WHERE user_id = ${user.id}`;
      await sql`DELETE FROM users WHERE id = ${user.id}`;
      return res.status(200).json({ success: true, message: `Deleted user ${userName}` });
    }

    res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Picks API error:', error);
    // Stack traces and driver messages no longer go to the client.
    return res.status(500).json({ error: 'Server error' });
  }
}
