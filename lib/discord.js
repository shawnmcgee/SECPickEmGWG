// /lib/discord.js
// Thin wrapper over a Discord channel webhook. No bot, no gateway connection,
// no token to keep alive -- a webhook URL is all a channel ping needs.

import { formatKickoffET } from './season';

const SNOWFLAKE = /^\d{17,20}$/;

/** Discord user IDs are snowflakes: 17-20 digits, nothing else. */
export function isValidDiscordUserId(id) {
  return typeof id === 'string' && SNOWFLAKE.test(id.trim());
}

export function discordConfigured() {
  return Boolean(process.env.DISCORD_WEBHOOK_URL);
}

/**
 * Post one message to the configured channel.
 *
 * `mentionUserIds` drives allowed_mentions, which is the safety rail: without
 * it a stray "@everyone" typed into a team name would ping the whole server.
 * With it, the only pings that can fire are the IDs passed here.
 */
export async function sendDiscordMessage({ content, mentionUserIds = [] }, { retries = 1 } = {}) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_WEBHOOK_URL is not set');

  const body = JSON.stringify({
    content: content.slice(0, 2000), // Discord's hard cap; a truncated ping beats a 400.
    allowed_mentions: {
      parse: [],
      users: mentionUserIds.filter(isValidDiscordUserId).map((id) => id.trim()),
    },
  });

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (res.ok || res.status === 204) return;

    // Webhooks are rate limited to roughly 5/sec, 30/min per webhook. A league
    // this size will not hit it, but honour Retry-After if we ever do.
    if (res.status === 429 && attempt < retries) {
      const payload = await res.json().catch(() => ({}));
      const waitMs = Math.min(Number(payload.retry_after ?? 1) * 1000, 10000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const detail = await res.text().catch(() => '');
    throw new Error(`Discord webhook ${res.status}: ${detail.slice(0, 200)}`);
  }
}

/**
 * The reminder text itself. Lives here rather than in the sweep so the
 * commissioner's test ping renders through this exact function -- a test that
 * built its own string would prove nothing about what actually goes out.
 */
export function buildReminderMessage({ discordUserId, name, games, siteUrl }) {
  const count = games.length;
  const lines = games.map(
    (g) => `• ${g.away_team} at ${g.home_team} — ${formatKickoffET(g.kickoff_at)}`
  );
  const head =
    `<@${discordUserId}> heads up ${name} — ${count} game${count === 1 ? '' : 's'} ` +
    `you haven't picked lock${count === 1 ? 's' : ''} within the hour:`;
  return [head, ...lines, siteUrl ? `\nPick 'em: ${siteUrl}` : null]
    .filter(Boolean)
    .join('\n');
}

/**
 * Stand-in slate for the test ping. Kickoffs are relative to now, so the ET
 * times read like a real Saturday rather than a frozen date, and rounded up to
 * the next half hour -- real kickoffs sit on :00 or :30, and "Sat 9:42 PM"
 * would make the wording look wrong when it is only the sample that is off.
 */
export function sampleReminderGames(now = new Date()) {
  const HALF_HOUR = 30 * 60000;
  const first = Math.ceil((now.getTime() + 65 * 60000) / HALF_HOUR) * HALF_HOUR;
  const at = (offsetMs) => new Date(first + offsetMs).toISOString();
  return [
    { away_team: 'Georgia', home_team: 'Alabama', kickoff_at: at(0) },
    { away_team: 'LSU', home_team: 'Ole Miss', kickoff_at: at(3.5 * 3600000) },
  ];
}
