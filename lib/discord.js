// /lib/discord.js
// Thin wrapper over a Discord channel webhook. No bot, no gateway connection,
// no token to keep alive -- a webhook URL is all a channel ping needs.

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
