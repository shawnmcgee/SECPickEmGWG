// /api/notify-settings.js
// Per-player Discord reminder settings: the user ID to ping and an on/off
// toggle. Nothing here reads or writes picks.
//
// Trust model matches the rest of the app: there is no real auth, players are
// identified by the name they type. Anyone who can save picks as a name can
// also set that name's reminder settings. If you want this locked down, gate
// POST on ADMIN_PASSWORD the way /api/picks DELETE does.
import { sql } from '../lib/db';
import { isValidDiscordUserId } from '../lib/discord';

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const userName = url.searchParams.get('userName');
      if (!userName) return res.status(400).json({ error: 'userName required' });

      const [row] = await sql`
        SELECT discord_user_id, notify_enabled
        FROM users WHERE name = ${userName}
      `;

      // An unknown name is not an error: a player who has never saved a pick
      // has no users row yet, and should still be able to open the panel.
      return res.status(200).json({
        userName,
        discordUserId: row?.discord_user_id ?? '',
        notifyEnabled: row?.notify_enabled ?? false,
        known: Boolean(row),
      });
    }

    if (req.method === 'POST') {
      const { userName, discordUserId, notifyEnabled } = readBody(req);
      const name = String(userName ?? '').trim().slice(0, 40);
      if (!name) return res.status(400).json({ error: 'userName required' });

      const rawId = String(discordUserId ?? '').trim();
      // Empty clears the link. Anything else must be a real snowflake -- a
      // typo'd ID would quietly ping a stranger, or nobody at all.
      if (rawId && !isValidDiscordUserId(rawId)) {
        return res.status(400).json({
          error: 'Discord user ID must be 17-20 digits. Enable Developer Mode in Discord, then right-click your name and "Copy User ID".',
        });
      }
      const id = rawId || null;
      const enabled = Boolean(notifyEnabled);

      // Can't be on without somewhere to send it.
      if (enabled && !id) {
        return res.status(400).json({ error: 'Add your Discord user ID before turning reminders on' });
      }

      // Upsert so a player can set reminders up before their first pick.
      const [row] = await sql`
        INSERT INTO users (name, discord_user_id, notify_enabled)
        VALUES (${name}, ${id}, ${enabled})
        ON CONFLICT (name) DO UPDATE SET
          discord_user_id = EXCLUDED.discord_user_id,
          notify_enabled  = EXCLUDED.notify_enabled
        RETURNING discord_user_id, notify_enabled
      `;

      return res.status(200).json({
        success: true,
        userName: name,
        discordUserId: row?.discord_user_id ?? '',
        notifyEnabled: row?.notify_enabled ?? false,
      });
    }

    res.setHeader('Allow', ['GET', 'POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Notify settings error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
}
