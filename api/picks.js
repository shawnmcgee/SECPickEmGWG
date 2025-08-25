// /api/picks.js
import { sql } from '../lib/db';

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const { userName, week, picks } = await req.json?.() ?? req.body;
      if (!userName || !Array.isArray(picks)) {
        return res.status(400).json({ error: 'userName and picks required' });
      }

      // upsert user
      const [{ id: user_id }] = await sql`
        INSERT INTO users (name)
        VALUES (${userName})
        ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;

      // ensure games exist (id, week, teams, lines, kickoff) before inserting picks
      // you can insert/merge here based on your /api/games response

      // insert picks
      for (const p of picks) {
        // p = { gameId, pickType: 'spread'|'total', selection: 'home'|'away'|'over'|'under', line }
        await sql`
          INSERT INTO picks (user_id, game_id, pick_type, selection, line)
          VALUES (${user_id}, ${p.gameId}, ${p.pickType}, ${p.selection}, ${p.line})
          ON CONFLICT (user_id, game_id)
          DO UPDATE SET pick_type = EXCLUDED.pick_type,
                        selection = EXCLUDED.selection,
                        line = EXCLUDED.line
        `;
      }

      return res.status(200).json({ ok: true });
    }

    if (req.method === 'GET') {
      const { userName, week } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      if (!userName || !week) return res.status(400).json({ error: 'userName and week required' });

      const rows = await sql`
        SELECT p.game_id, p.pick_type, p.selection, p.line
        FROM picks p
        JOIN users u ON u.id = p.user_id
        JOIN games g ON g.id = p.game_id
        WHERE u.name = ${userName} AND g.week = ${Number(week)}
      `;
      return res.status(200).json({ picks: rows });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e) });
  }
}
