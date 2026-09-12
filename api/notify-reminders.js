// /api/notify-reminders.js
// Pings opted-in players on Discord when a game they have not picked is about
// to lock. Triggered on a schedule (see .github/workflows/pick-reminders.yml),
// never by a browser.
//
// Note on "unsaved" picks: a selection that has been tapped but not submitted
// lives only in the browser's `dirty` flag (app.js) and never reaches the
// server, so there is no way to distinguish it from a pick that was never made.
// Both are treated the same here -- an unsaved pick does not count, so the
// message is accurate either way.
import { sql } from '../lib/db';
import { SEASON, SCORING_MIN_WEEK, formatKickoffET } from '../lib/season';
import { sendDiscordMessage, discordConfigured } from '../lib/discord';

// How far ahead of kickoff to warn. Deliberately wider than the "one hour"
// this implements: GitHub Actions schedules drift, routinely by 5-15 minutes,
// so a window pinned at exactly 60 would let games slip past unpinged. The
// dedupe table is what keeps the wide window from re-sending, and in practice
// a player hears about it 60-75 minutes out.
const DEFAULT_LEAD_MINUTES = 75;

function leadMinutes() {
  const n = Number(process.env.REMINDER_LEAD_MINUTES);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_LEAD_MINUTES;
}

function buildMessage({ discordUserId, name, games, siteUrl }) {
  const count = games.length;
  const lines = games.map((g) => `• ${g.away_team} at ${g.home_team} — ${formatKickoffET(g.kickoff_at)}`);
  const head =
    `<@${discordUserId}> heads up ${name} — ${count} game${count === 1 ? '' : 's'} ` +
    `you haven't picked lock${count === 1 ? 's' : ''} within the hour:`;
  return [head, ...lines, siteUrl ? `\nPick 'em: ${siteUrl}` : null]
    .filter(Boolean)
    .join('\n');
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // An unset secret would leave an endpoint that pings the whole league open to
  // anyone who guesses the path, so refuse rather than fall back to open.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = new URL(req.url, 'http://x');
  // Shows exactly what would be sent, without sending or recording anything.
  // The way to test the whole pipeline without spamming the channel.
  const dryRun = url.searchParams.get('dryRun') === '1';

  if (!dryRun && !discordConfigured()) {
    return res.status(500).json({ error: 'DISCORD_WEBHOOK_URL is not configured' });
  }

  try {
    const lead = leadMinutes();

    // Opted-in players x games locking soon, minus anything already picked and
    // anything already pinged. The test week is excluded: it is scratch data
    // and nobody wants a 6am ping about it.
    const rows = await sql`
      SELECT u.id AS user_id, u.name, u.discord_user_id,
             g.id AS game_id, g.home_team, g.away_team, g.kickoff_at
      FROM users u
      CROSS JOIN games g
      LEFT JOIN picks p ON p.user_id = u.id AND p.game_id = g.id
      LEFT JOIN pick_reminders_sent s ON s.user_id = u.id AND s.game_id = g.id
      WHERE u.notify_enabled
        AND u.discord_user_id IS NOT NULL
        AND g.season = ${SEASON}
        AND g.week >= ${SCORING_MIN_WEEK}
        AND g.kickoff_at IS NOT NULL
        AND g.kickoff_at > NOW()
        AND g.kickoff_at <= NOW() + make_interval(mins => ${lead})
        AND p.user_id IS NULL
        AND s.user_id IS NULL
      ORDER BY u.name ASC, g.kickoff_at ASC
    `;

    // One message per player listing every imminent game they are missing,
    // rather than one ping per game. Three unpicked games on a Saturday should
    // be one notification, not three.
    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) {
        byUser.set(r.user_id, {
          userId: r.user_id,
          name: r.name,
          discordUserId: r.discord_user_id,
          games: [],
        });
      }
      byUser.get(r.user_id).games.push(r);
    }

    const siteUrl = process.env.PICKEM_SITE_URL || '';
    const sent = [];
    const failed = [];

    for (const entry of byUser.values()) {
      const content = buildMessage({ ...entry, siteUrl });

      if (dryRun) {
        sent.push({ name: entry.name, games: entry.games.length, content });
        continue;
      }

      try {
        await sendDiscordMessage({ content, mentionUserIds: [entry.discordUserId] });
      } catch (e) {
        // Leave the dedupe rows unwritten so the next sweep retries. Better a
        // duplicate ping than a silent miss an hour before kickoff.
        console.error(`Discord send failed for ${entry.name}:`, e.message);
        failed.push({ name: entry.name, reason: e.message });
        continue;
      }

      // Recorded only after the message actually landed.
      try {
        const gameIds = entry.games.map((g) => g.game_id);
        await sql`
          INSERT INTO pick_reminders_sent (user_id, game_id)
          SELECT ${entry.userId}, UNNEST(${gameIds}::text[])
          ON CONFLICT (user_id, game_id) DO NOTHING
        `;
      } catch (e) {
        // The ping went out; failing to log it only risks a repeat next sweep.
        console.error(`Failed to record reminders for ${entry.name}:`, e.message);
      }

      sent.push({ name: entry.name, games: entry.games.length });
    }

    return res.status(200).json({
      dryRun,
      leadMinutes: lead,
      candidates: rows.length,
      notified: sent.length,
      sent,
      failed,
    });
  } catch (error) {
    console.error('Reminder sweep error:', error);
    // The most likely first-run failure by a distance. Say so plainly rather
    // than making someone read the function logs to find it.
    if (/notify_enabled|discord_user_id|pick_reminders_sent/.test(error.message || '')) {
      return res.status(500).json({
        error: 'Reminder schema is missing. Run sql/001_discord_notifications.sql against the database.',
      });
    }
    return res.status(500).json({ error: 'Reminder sweep failed' });
  }
}
