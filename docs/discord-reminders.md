# Discord pick reminders

Pings opted-in players in a Discord channel about an hour before a game locks,
if they still have picks open for it.

## How it works

The GitHub Actions workflow sweeps `/api/notify-reminders` every 5 minutes on
game days. Each sweep looks for games kicking off inside the lead window (75
minutes), finds opted-in players with no saved pick for them, and posts one
grouped message per player to a Discord channel webhook. Reminders land 70–75
minutes before kickoff.

Every `(player, game)` that has been pinged is recorded in
`pick_reminders_sent`, so however often the sweep runs, and however wide its
window, each player hears about each game exactly once.

### Why the workflow is a loop, not a cron job

**GitHub Actions silently drops most high-frequency cron firings.** Over the
first 56 days of the 2026 season, a ten-minute schedule averaged 5.4 runs a day
instead of 144, with gaps up to ~10 hours. One sweep per run meant reminders
went out a median 3.6 hours before kickoff — easy to forget by game time — and
about 8% of the clock had no coverage at all.

A run that does start, though, runs reliably. So each run is a loop
(`.github/scripts/reminder-loop.sh`):

1. Sweep every 5 minutes for ~5h40m (the hosted-job limit is 6 hours).
2. Start its own successor with `workflow_dispatch`, which cron's dropping does
   not affect, and exit.
3. Go idle — exit *without* a successor — once the next reminder is more than
   24 hours out, so it is not holding a runner all week. On Thursday–Saturday
   (ET) it stays up even with no games loaded yet, because a slate only reaches
   the database once someone opens that week in the app.

Cron is now just a wake-up call. It only has to land once in the 24-hour runway
before a slate, and the worst gap observed was under 10 hours.

Guard rails:

- **One loop at a time.** A run stands down if an older run of the workflow is
  already looping, so wake-up calls that land mid-slate exit in seconds. There
  is deliberately no `concurrency:` group — it would queue those calls and
  cancel them against each other.
- **Fails toward sending.** If the endpoint errors or the next kickoff is
  unknown, the loop stays awake and keeps sweeping.
- **Loud on real breakage.** A 401 fails the run immediately. Six failed sweeps
  in a row (30 min) stop the loop and fail the run, so GitHub emails you; the
  next wake-up call tries again.
- **Stays enabled.** GitHub disables scheduled workflows in public repos after
  60 days without a commit, and a disabled workflow cannot run at all. Each
  loop run re-enables the workflow, which resets that clock.

Merging a change to the workflow, the loop script, or the endpoint starts the
loop straight away (after a 2-minute pause for Vercel to deploy). To start it
by hand: **Actions → Pick reminders → Run workflow** with *Report who would be
pinged* **unchecked**. Checked — the default — is a one-off dry run.

To stop reminders: **Actions → Pick reminders → ⋯ → Disable workflow**, then
cancel the run in progress.

### How wide the window is

The loop declares its cadence: it calls
`/api/notify-reminders?nextSweepMinutes=5`, and the endpoint uses a fixed
75-minute window, since any sweep interval shorter than the lead catches every
game. (Without this, the first sweep after a quiet midweek would see a gap of
days and widen the window to the 6-hour cap, pinging hours early.)

A caller that does *not* declare a cadence — an external scheduler, say — gets
the older adaptive behaviour: each real sweep records itself in
`reminder_sweeps`, and the next widens its window to 1.5× the gap since, capped
at `REMINDER_MAX_LEAD_MINUTES` (default 360). When that widens past the lead,
the response sets `windowWidened: true`.

Dry runs deliberately do not record a sweep: nothing was sent, so nothing was
covered.

`REMINDER_LEAD_MINUTES` sets the lead (default 75);
`REMINDER_MAX_LEAD_MINUTES` caps any widening (default 360).

### Belt and braces: an external scheduler

The loop needs nothing outside this repo. If you want a second, independent
trigger anyway, point any of these at the same endpoint — the dedupe table
means whichever sweep gets there first sends and the other finds nothing:

| Option | Cost | Granularity |
| --- | --- | --- |
| [cron-job.org](https://cron-job.org) | free | 1 minute, supports custom headers |
| [Upstash QStash](https://upstash.com/docs/qstash) | free tier | 1 minute |
| Vercel Cron | Pro plan | 1 minute (Hobby is once a day) |

Each needs one POST to
`https://your-site/api/notify-reminders?nextSweepMinutes=10` (match the number
to its interval) with the header `Authorization: Bearer <CRON_SECRET>`.

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

The workflow's **Run workflow** button defaults to a dry run: one sweep, nothing sent, no loop.

## Notes

- The **Who has picked** list shows a 🔔 next to players who have reminders on.
- `/api/status` reports only whether reminders are on, never the Discord ID.
- The test week (week 0) is excluded — it is scratch data.
- If a Discord send fails, the dedupe rows are not written, so the next sweep
  retries. A duplicate ping beats a silent miss an hour before kickoff.
