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
| `ADMIN_PASSWORD` | yes | Already used by the other commissioner tools. Reminder settings are gated on it too. |

### 4. GitHub repository secrets

**Settings → Secrets and variables → Actions**:

- `PICKEM_SITE_URL` — the deployed site's base URL.
- `CRON_SECRET` — must match the Vercel value exactly.

### 5. Opt players in

Reminders are managed by the commissioner, not by players themselves. Open
**Commissioner tools**, enter the admin password, then under **Discord
reminders** press *Load reminder settings*. Paste each player's Discord user ID,
tick **Ping** for the ones who want reminders, and press *Save reminders*.

To find a player's ID: in Discord, **Settings → Advanced → Developer Mode**,
then right-click their name and **Copy User ID**.

Reminders default to off, and cannot be turned on without an ID.

#### Why commissioner-gated

Players are identified app-wide by the name they type, which is fine for picks
— the worst case is someone spoiling their own week. A Discord ID points at a
real person's account, though, so a self-service field would let anyone aim a
recurring ping at a stranger. `ADMIN_PASSWORD` gates both reading and writing
these settings, and `/api/notify-settings` is POST-only so the password stays
out of URLs, browser history and access logs.

## Testing without spamming the channel

`?dryRun=1` reports exactly who would be pinged and with what text, without
sending anything or writing dedupe rows:

```sh
curl -X POST "https://your-site/api/notify-reminders?dryRun=1" \
  -H "Authorization: Bearer $CRON_SECRET"
```

The workflow also has a **Run workflow** button that defaults to a dry run.

## Notes

- The **Who has picked** list shows a 🔔 next to players who have reminders on.
- `/api/status` reports only whether reminders are on, never the Discord ID.
- The test week (week 0) is excluded — it is scratch data.
- If a Discord send fails, the dedupe rows are not written, so the next sweep
  retries. A duplicate ping beats a silent miss an hour before kickoff.
