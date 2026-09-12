// /api/notify-settings.js
// Per-player Discord reminder settings: the user ID to ping and an on/off
// toggle. Nothing here reads or writes picks.
//
// Commissioner-only. Players are identified app-wide by the name they type,
// which is fine for picks -- the worst case is someone spoiling their own week
// -- but a self-service Discord field would let anyone point a ping at a real
// stranger's account. So this sits behind ADMIN_PASSWORD like the rest of the
// commissioner tools, and the whole UI lives in that panel.
//
// POST only, both for reading and writing: the password travels in the body,
// where it stays out of URLs, browser history and access logs.
import { sql } from '../lib/db';
import {
  isValidDiscordUserId,
  discordConfigured,
  sendDiscordMessage,
  buildReminderMessage,
  sampleReminderGames,
} from '../lib/discord';

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

/**
 * If ADMIN_PASSWORD is unset, `adminPassword !== process.env.ADMIN_PASSWORD`
 * compares undefined to undefined, returns false, and lets a request with no
 * password straight through. The first clause closes that.
 */
function checkAdmin(adminPassword) {
  if (!process.env.ADMIN_PASSWORD) return 'Admin password is not configured on the server';
  if (adminPassword !== process.env.ADMIN_PASSWORD) return 'Invalid admin password';
  return null;
}

const MISSING_SCHEMA = /notify_enabled|discord_user_id/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { adminPassword, action = 'list', settings, userName, discordUserId } = readBody(req);

    const authError = checkAdmin(adminPassword);
    if (authError) return res.status(401).json({ error: authError });

    /* ------------------------------------------------------------------ */
    if (action === 'list') {
      const rows = await sql`
        SELECT name, discord_user_id, notify_enabled
        FROM users
        ORDER BY name ASC
      `;
      return res.status(200).json({
        players: rows.map((r) => ({
          userName: r.name,
          discordUserId: r.discord_user_id ?? '',
          notifyEnabled: Boolean(r.notify_enabled),
        })),
      });
    }

    /* ------------------------------------------------------------------ */
    if (action === 'save') {
      if (!Array.isArray(settings) || settings.length === 0) {
        return res.status(400).json({ error: 'settings array required' });
      }

      // Validate the whole batch before writing any of it, so a single typo'd
      // ID cannot leave half the roster updated and half not.
      const pending = [];
      for (const entry of settings) {
        const name = String(entry?.userName ?? '').trim().slice(0, 40);
        if (!name) return res.status(400).json({ error: 'Every entry needs a userName' });

        const rawId = String(entry?.discordUserId ?? '').trim();
        // Empty clears the link. Anything else must be a real snowflake -- a
        // typo'd ID would quietly ping a stranger, or nobody at all.
        if (rawId && !isValidDiscordUserId(rawId)) {
          return res.status(400).json({
            error: `${name}: Discord user ID must be 17-20 digits. In Discord, turn on Developer Mode, then right-click the player and "Copy User ID".`,
          });
        }

        const enabled = Boolean(entry?.notifyEnabled);
        // Can't be on without somewhere to send it.
        if (enabled && !rawId) {
          return res.status(400).json({ error: `${name}: add a Discord user ID before turning reminders on` });
        }

        pending.push({ name, id: rawId || null, enabled });
      }

      let saved = 0;
      for (const p of pending) {
        // Upsert so a player can be set up before their first pick.
        await sql`
          INSERT INTO users (name, discord_user_id, notify_enabled)
          VALUES (${p.name}, ${p.id}, ${p.enabled})
          ON CONFLICT (name) DO UPDATE SET
            discord_user_id = EXCLUDED.discord_user_id,
            notify_enabled  = EXCLUDED.notify_enabled
        `;
        saved++;
      }

      return res.status(200).json({ success: true, saved });
    }

    /* ------------------------------------------------------------------ */
    if (action === 'test') {
      if (!discordConfigured()) {
        return res.status(500).json({ error: 'DISCORD_WEBHOOK_URL is not configured on the server' });
      }

      const name = String(userName ?? '').trim().slice(0, 40) || 'there';
      const rawId = String(discordUserId ?? '').trim();
      if (!isValidDiscordUserId(rawId)) {
        return res.status(400).json({ error: `${name}: add a valid Discord user ID before sending a test` });
      }

      // Built by the same function the real sweep uses, so this is the actual
      // wording -- only the slate is invented. The banner keeps a test ping
      // from reading as a genuine one in the channel.
      const body = buildReminderMessage({
        discordUserId: rawId,
        name,
        games: sampleReminderGames(),
        siteUrl: process.env.PICKEM_SITE_URL || '',
      });
      const content = `**Test ping** — this is exactly how a real pick reminder reads.\n\n${body}`;

      try {
        await sendDiscordMessage({ content, mentionUserIds: [rawId] });
      } catch (e) {
        console.error('Test ping failed:', e.message);
        return res.status(502).json({ error: `Discord rejected the message: ${e.message}` });
      }

      // Returned so the panel can show the wording without a trip to Discord.
      return res.status(200).json({ success: true, sentTo: name, content });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (error) {
    console.error('Notify settings error:', error);
    if (MISSING_SCHEMA.test(error.message || '')) {
      return res.status(500).json({
        error: 'Reminder schema is missing. Run sql/001_discord_notifications.sql against the database.',
      });
    }
    return res.status(500).json({ error: 'Server error' });
  }
}
