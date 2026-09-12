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
import { SEASON, SCORING_MIN_WEEK } from '../lib/season';
import { sendDiscordMessage, discordConfigured, buildReminderMessage } from '../lib/discord';

// How far ahead of kickoff to warn, when the sweep is running on time.
const DEFAULT_LEAD_MINUTES = 75;

// Ceiling on the adaptive widening below. Past this the reminder is so far
// ahead of kickoff that it stops being a reminder, and a sweep that has been
// down for days should not ping about next weekend's slate.
const DEFAULT_MAX_LEAD_MINUTES = 360;

function envMinutes(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * The window has to be wider than the interval between sweeps, or games lock
 * in the gap and are never pinged -- `kickoff_at > NOW()` drops them for good.
 *
 * A fixed window cannot guarantee that, because the scheduler's real cadence
 * is not ours to choose: GitHub Actions silently drops most high-frequency
 * firings, and a ten-minute schedule was observed producing three runs in
 * eight hours (gaps of 250 and 215 minutes). So measure the gap since the last
 * real sweep and cover 1.5x of it, which absorbs the next gap being somewhat
 * worse than the last.
 *
 * On a healthy scheduler the gap is small and this stays at the configured
 * lead, so fixing the cadence tightens the window automatically -- nothing to
 * reconfigure. A missing sweep log (migration not yet run) falls back to the
 * fixed lead rather than failing the sweep.
 */
async function resolveWindow() {
  const lead = envMinutes('REMINDER_LEAD_MINUTES', DEFAULT_LEAD_MINUTES);
  const max = Math.max(lead, envMinutes('REMINDER_MAX_LEAD_MINUTES', DEFAULT_MAX_LEAD_MINUTES));

  let gapMinutes = null;
  try {
    const [row] = await sql`
      SELECT EXTRACT(EPOCH FROM (NOW() - last_run_at)) / 60 AS gap_minutes
      FROM reminder_sweeps WHERE id = 1
    `;
    if (row?.gap_minutes != null) gapMinutes = Number(row.gap_minutes);
  } catch (e) {
    console.warn('Sweep log unavailable (run sql/002_reminder_sweeps.sql):', e.message);
  }

  const needed = gapMinutes === null ? lead : Math.ceil(gapMinutes * 1.5);
  return { lead, max, gapMinutes, minutes: Math.min(Math.max(lead, needed), max) };
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
    const window = await resolveWindow();
    const lead = window.minutes;

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
      const content = buildReminderMessage({ ...entry, siteUrl });

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

    // A dry run deliberately does not record a sweep: nothing was sent, so it
    // covered nothing, and marking it would shrink the next real window.
    if (!dryRun) {
      try {
        await sql`
          INSERT INTO reminder_sweeps (id, last_run_at) VALUES (1, NOW())
          ON CONFLICT (id) DO UPDATE SET last_run_at = NOW()
        `;
      } catch (e) {
        console.warn('Could not record sweep (run sql/002_reminder_sweeps.sql):', e.message);
      }
    }

    return res.status(200).json({
      dryRun,
      leadMinutes: lead,
      configuredLeadMinutes: window.lead,
      // How long since the last real sweep, and whether that forced the window
      // wider than configured. A widened window is the scheduler under-running.
      minutesSinceLastSweep: window.gapMinutes === null ? null : Math.round(window.gapMinutes),
      windowWidened: lead > window.lead,
      candidates: rows.length,
      notified: sent.length,
      sent,
      failed,
    });
  } catch (error) {
    console.error('Reminder sweep error:', error);
    // The most likely first-run failure by a distance. Say so plainly rather
    // than making someone read the function logs to find it.
    if (/notify_enabled|discord_user_id|pick_reminders_sent|reminder_sweeps/.test(error.message || '')) {
      return res.status(500).json({
        error: 'Reminder schema is missing. Run the files in sql/ against the database.',
      });
    }
    return res.status(500).json({ error: 'Reminder sweep failed' });
  }
}
