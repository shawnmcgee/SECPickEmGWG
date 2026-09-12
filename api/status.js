// /api/status.js
// Who has saved picks for a given week, and who still owes you some.
// Counts only -- it never reveals what anyone picked, so it is safe to check
// before kickoff without spoiling the slate.
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
    const week = weekParam === null || weekParam === '' ? null : clampWeek(weekParam);
    if (week === null) return res.status(400).json({ error: 'week parameter required' });
    const season = Number(url.searchParams.get('seasonYear')) || SEASON;

    const [games, players] = await Promise.all([
      sql`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE kickoff_at IS NOT NULL AND kickoff_at <= NOW())::int AS locked,
          MIN(kickoff_at) FILTER (WHERE kickoff_at > NOW()) AS next_kickoff
        FROM games
        WHERE season = ${season} AND week = ${week}
      `,
      sql`
        SELECT
          u.name,
          COUNT(*) FILTER (WHERE g.week = ${week})::int AS week_picks,
          COUNT(*) FILTER (WHERE g.id IS NOT NULL)::int AS season_picks
        FROM users u
        LEFT JOIN picks p ON p.user_id = u.id
        LEFT JOIN games g ON g.id = p.game_id AND g.season = ${season}
        GROUP BY u.name
        ORDER BY u.name ASC
      `,
    ]);

    // Kept separate and best-effort on purpose: these columns only exist once
    // sql/001_discord_notifications.sql has been run. Folding them into the
    // roster query would mean a deploy ahead of that migration takes the whole
    // commissioner panel down, not just the bell icons.
    let remindersOn = new Set();
    try {
      const rows = await sql`
        SELECT name FROM users
        WHERE notify_enabled AND discord_user_id IS NOT NULL
      `;
      remindersOn = new Set(rows.map((r) => r.name));
    } catch (e) {
      console.warn('Reminder columns unavailable (run sql/001_discord_notifications.sql):', e.message);
    }

    const total = games[0]?.total ?? 0;
    const locked = games[0]?.locked ?? 0;

    const roster = players.map((p) => {
      const made = p.week_picks;
      const missing = Math.max(0, total - made);
      return {
        name: p.name,
        picked: made,
        missing,
        // Informational only. Deliberately does NOT filter anyone out of the
        // reminder list: at week 1 nobody has season picks yet, so excluding
        // on this would return an empty list exactly when you need it, and it
        // would also hide a genuinely new player who hasn't started.
        // To drop someone who has left the league, delete them outright.
        noPicksThisSeason: p.season_picks === 0,
        // Whether this player gets a Discord ping before kickoff. The ID
        // itself is deliberately not returned -- the panel only needs to know
        // that reminders are wired up, not who to ping.
        remindersOn: remindersOn.has(p.name),
        state: made === 0 ? 'none' : missing === 0 ? 'complete' : 'partial',
      };
    });

    return res.status(200).json({
      season,
      week,
      testWeek: isTestWeek(week),
      totalGames: total,
      lockedGames: locked,
      openGames: total - locked,
      nextKickoff: games[0]?.next_kickoff ?? null,
      players: roster,
      summary: {
        complete: roster.filter((p) => p.state === 'complete').length,
        partial: roster.filter((p) => p.state === 'partial').length,
        none: roster.filter((p) => p.state === 'none').length,
        // Everyone short of a full slate. No cleverness.
        needsReminder: roster.filter((p) => p.state !== 'complete').map((p) => p.name),
      },
    });
  } catch (error) {
    console.error('Status API error:', error);
    return res.status(500).json({ error: 'Failed to load pick status' });
  }
}
