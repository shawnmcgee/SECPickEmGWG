# Discord pick reminders

Pings opted-in players in a Discord channel about an hour before a game locks,
if they still have picks open for it.

## How it works

A scheduler POSTs to `/api/notify-reminders` every few minutes (a GitHub Actions
workflow ships as the default — see the caveat below). The endpoint looks for games kicking off inside the lead window, finds
opted-in players with no saved pick for them, and posts one grouped message per
player to a Discord channel webhook.

Every `(player, game)` that has been pinged is recorded in
`pick_reminders_sent`, so however often the sweep runs, and however wide its
window, each player hears about each game exactly once.

### The scheduler is the weak link

**GitHub Actions does not merely delay high-frequency cron — it silently drops
most firings.** Observed on this repo: a ten-minute schedule produced three runs
in eight hours, with gaps of 250 and 215 minutes. The run numbers were
consecutive, confirming the missing runs were never created rather than failing.

That is fatal for a fixed window. A game locking in a 250-minute gap is never
pinged at all: once `kickoff_at` passes, the sweep drops it for good.

**For reliable timing, point a real scheduler at the same endpoint** — the
workflow is a backstop, not the plan:

| Option | Cost | Granularity |
| --- | --- | --- |
| [cron-job.org](https://cron-job.org) | free | 1 minute, supports custom headers |
| [Upstash QStash](https://upstash.com/docs/qstash) | free tier | 1 minute |
| Vercel Cron | Pro plan | 1 minute (Hobby is once a day) |

Any of them needs one POST to `https://your-site/api/notify-reminders` with the
header `Authorization: Bearer <CRON_SECRET>`. Every ten minutes is plenty. Once
a real scheduler is running, disable this repo's workflow (Actions → Pick
reminders → ⋯ → Disable workflow) so the two do not overlap — though they are
safe together, since the dedupe table means whichever sweep gets there first
sends and the other finds nothing.

### The window adapts to whatever cadence it actually gets

Because the cadence is not ours to choose, the endpoint measures it. Each real
sweep records itself in `reminder_sweeps`; the next one reads the gap and widens
its window to 1.5× of it, capped at `REMINDER_MAX_LEAD_MINUTES` (default 360).

| Gap since last sweep | Window used |
| --- | --- |
| first run ever | 75 min |
| 10 min (healthy) | 75 min |
| 60 min | 90 min |
| 250 min (observed) | 360 min |
| days (sweep was down) | 360 min, capped |

So a dropped schedule delays a reminder rather than losing it, and fixing the
cadence tightens the window back down on its own with nothing to reconfigure.
When the window is widened, the response sets `windowWidened: true` and the
workflow logs a warning — that flag is the signal your scheduler is
under-running.

Dry runs deliberately do not record a sweep: nothing was sent, so nothing was
covered, and marking it would shrink the next real window.

`REMINDER_LEAD_MINUTES` sets the floor (default 75);
`REMINDER_MAX_LEAD_MINUTES` sets the ceiling (default 360).

### "Unsaved" vs. "unselected" picks

A pick that has been tapped but not submitted lives only in the browser's
`dirty` flag (`app.js`) and never reaches the server, so nothing server-side can
tell it apart from a pick that was never made. Both count as open here — which
is correct, since an unsaved pick would not be graded either.

## Setup

### 1. Database

Run both files in `sql/` against the Neon database (the Neon console's SQL
editor is fine), in order:

1. `sql/001_discord_notifications.sql` — settings columns and the dedupe table.
2. `sql/002_reminder_sweeps.sql` — the sweep log the adaptive window reads.

Every statement is idempotent, so re-running either is harmless.

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
| `REMINDER_LEAD_MINUTES` | no | Floor for the reminder window, in minutes. Defaults to `75`. |
| `REMINDER_MAX_LEAD_MINUTES` | no | Ceiling for adaptive widening. Defaults to `360`. |
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

## The message

```
<@172150183989770240> heads up Shawn — 2 games you haven't picked lock within the hour:
• Georgia at Alabama — Sat 3:30 PM ET
• LSU at Ole Miss — Sat 7:00 PM ET

Pick 'em: https://secpickem.vercel.app
```

The trailing link only appears when `PICKEM_SITE_URL` is set. Singular and
plural both read correctly ("1 game … locks", "2 games … lock"). Wording lives
in `buildReminderMessage` in `lib/discord.js`.

## Sending a real test ping

Each row in **Commissioner tools → Discord reminders** has a **Test** button. It
posts a real message to the channel, pinging the ID currently typed into that
row — so delivery can be verified before saving anything, and before any game
is close to locking. The wording also appears inline under the row.

The test is built by the same `buildReminderMessage` the live sweep uses, with
only the slate invented, so it cannot drift from what actually ships. It carries
a **Test ping** banner so nobody in the channel mistakes it for a real one, and
it writes nothing to `pick_reminders_sent`.

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
