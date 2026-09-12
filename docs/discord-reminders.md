# Discord pick reminders

Pings opted-in players in a Discord channel about an hour before a game locks,
if they still have picks open for it.

## How it works

A scheduled GitHub Actions workflow POSTs to `/api/notify-reminders` every ten
minutes. The endpoint looks for games kicking off inside the lead window, finds
opted-in players with no saved pick for them, and posts one grouped message per
player to a Discord channel webhook.

Every `(player, game)` that has been pinged is recorded in
`pick_reminders_sent`, so a ten-minute sweep against a seventy-five minute
window sends exactly once.

### Why the window is 75 minutes, not 60

GitHub Actions cron is best-effort and routinely fires 5–15 minutes late. A
window pinned at exactly 60 would let games slip past unpinged. The dedupe
table is what makes the wider window safe — in practice a player hears about it
60–75 minutes before kickoff. Tune it with `REMINDER_LEAD_MINUTES` if you like.

### "Unsaved" vs. "unselected" picks

A pick that has been tapped but not submitted lives only in the browser's
`dirty` flag (`app.js`) and never reaches the server, so nothing server-side can
tell it apart from a pick that was never made. Both count as open here — which
is correct, since an unsaved pick would not be graded either.

## Setup

### 1. Database

Run `sql/001_discord_notifications.sql` once against the Neon database (the
Neon console's SQL editor is fine). Every statement is idempotent.

### 2. Discord webhook

In Discord: **Server Settings → Integrations → Webhooks → New Webhook**. Pick
the channel the reminders should post in and copy the webhook URL.

Treat that URL as a secret — anyone holding it can post to the channel.

### 3. Environment variables (Vercel)

| Variable | Required | Notes |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | yes | The webhook from step 2. |
| `CRON_SECRET` | yes | Any long random string. The endpoint refuses to run without it rather than falling back to open. |
| `PICKEM_SITE_URL` | no | Included as a link in the message, e.g. `https://pickem.example.com`. |
| `REMINDER_LEAD_MINUTES` | no | Defaults to `75`. |

### 4. GitHub repository secrets

**Settings → Secrets and variables → Actions**:

- `PICKEM_SITE_URL` — the deployed site's base URL.
- `CRON_SECRET` — must match the Vercel value exactly.

### 5. Players opt in

Each player signs in, taps the bell in the header, pastes their Discord user ID
and turns reminders on. To find the ID: Discord **Settings → Advanced →
Developer Mode**, then right-click your name and **Copy User ID**.

Reminders default to off, and cannot be turned on without an ID.

## Testing without spamming the channel

`?dryRun=1` reports exactly who would be pinged and with what text, without
sending anything or writing dedupe rows:

```sh
curl -X POST "https://your-site/api/notify-reminders?dryRun=1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

The workflow also has a **Run workflow** button that defaults to a dry run.

## Notes

- The commissioner panel shows a 🔔 next to players who have reminders on.
- The test week (week 0) is excluded — it is scratch data.
- If a Discord send fails, the dedupe rows are not written, so the next sweep
  retries. A duplicate ping beats a silent miss an hour before kickoff.
- Reminder settings follow the same trust model as the rest of the app: players
  are identified by the name they type, so anyone who can save picks as a name
  can also change that name's reminder settings. To lock this down, gate the
  `POST` in `api/notify-settings.js` on `ADMIN_PASSWORD`, the way
  `api/picks.js` does for `DELETE`.
