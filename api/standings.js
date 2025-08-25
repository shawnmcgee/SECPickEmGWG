// /api/standings.js
import { sql } from '../lib/db';

function covered(spread, homeScore, awayScore) {
  const margin = homeScore - awayScore; // spread is for home team
  return margin + (-spread) < 0 ? 'away' : 'home'; // home covers if margin > -spread
}
function ouResult(total, homeScore, awayScore) {
  const pts = homeScore + awayScore;
  return pts > total ? 'over' : (pts < total ? 'under' : 'push');
}

export default async function handler(req, res) {
  try {
    const { week } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const filter = week ? sql`WHERE g.week = ${Number(week)}` : sql``;

    const rows = await sql`
      SELECT u.name, p.pick_type, p.selection, p.line, g.week,
             r.home_score, r.away_score, g.id AS game_id, g.spread, g.total
      FROM picks p
      JOIN users u ON u.id = p.user_id
      JOIN games g ON g.id = p.game_id
      JOIN results r ON r.game_id = g.id
      ${filter}
      AND r.home_score IS NOT NULL AND r.away_score IS NOT NULL
    `;

    const table = new Map(); // name -> { wins, losses, pushes }
    for (const row of rows) {
      const name = row.name;
      if (!table.has(name)) table.set(name, { wins: 0, losses: 0, pushes: 0 });

      if (row.pick_type === 'spread') {
        const winner = covered(row.spread, row.home_score, row.away_score); // 'home'|'away'
        if (row.home_score === row.away_score + row.spread) table.get(name).pushes++;
        else if (row.selection === winner) table.get(name).wins++;
        else table.get(name).losses++;
      } else {
        const result = ouResult(row.total, row.home_score, row.away_score); // 'over'|'under'|'push'
        if (result === 'push') table.get(name).pushes++;
        else if (row.selection === result) table.get(name).wins++;
        else table.get(name).losses++;
      }
    }

    // return leaderboard
    const standings = [...table.entries()]
      .map(([name, r]) => ({ name, ...r }))
      .sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses));

    return res.status(200).json({ standings, scope: week ? 'week' : 'season', week: week ? Number(week) : null });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String(e) });
  }
}
