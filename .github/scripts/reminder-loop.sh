#!/usr/bin/env bash
# Reminder loop. Called by .github/workflows/pick-reminders.yml.
#
# Why a loop: GitHub drops most high-frequency cron firings. A 10-minute
# schedule averaged 5.4 runs a day over 56 days (gaps up to ~10 hours), so the
# old one-sweep-per-run design pinged a median 3.6 hours before kickoff and
# left ~8% of the clock uncovered. Runs that DO start, though, run reliably.
# So one run sweeps every few minutes for nearly the 6-hour job limit, then
# starts its own successor via workflow_dispatch -- which is not subject to
# cron's dropping. Cron is demoted to a wake-up call.
#
# Between slates the loop goes idle (exits without a successor) so it is not
# burning a runner all week; the next cron firing that lands wakes it again.
#
# Rules this script keeps:
#   * Fail toward sending. Anything unknown (endpoint error, missing field, API
#     hiccup) means "stay awake and keep sweeping", never "go quiet".
#   * One loop at a time. If an older run is already looping, stand down. The
#     dedupe table makes an overlap harmless anyway; this just avoids waste.
#   * Config errors fail loudly and immediately; transient errors do not stop
#     the loop unless nothing has worked for half an hour.

set -uo pipefail

: "${SWEEP_INTERVAL_SECONDS:=300}"      # cadence while awake
: "${RUN_BUDGET_SECONDS:=20400}"        # 340 min; job timeout is 355
: "${AWAKE_HORIZON_HOURS:=24}"          # stay up if a reminder is due within this
: "${MAX_CONSECUTIVE_FAILURES:=6}"      # 6 x 5 min = 30 min of nothing working
: "${INITIAL_DELAY_SECONDS:=0}"         # lets a fresh Vercel deploy land first
: "${WORKFLOW_FILE:=pick-reminders.yml}"
: "${DRY_RUN:=0}"
: "${HANDOFF_FROM:=}"
: "${GITHUB_RUN_ID:=0}"
: "${GITHUB_REPOSITORY:=}"
: "${GITHUB_REF_NAME:=main}"

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }

# Secrets pasted through a web form routinely pick up a trailing newline, and
# a value that wrapped on screen can pick one up in the middle. Vercel serves
# HTTP/2, where an embedded newline in the Authorization header kills the
# request with "curl: (43) Failed sending HTTP request" -- which says nothing
# about the real cause. Strip and report.
clean() { printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

site=$(clean "${SITE_URL:-}")
secret=$(clean "${CRON_SECRET:-}")

if [ -z "$site" ] || [ -z "$secret" ]; then
  echo "::error::PICKEM_SITE_URL and CRON_SECRET repository secrets must both be set."
  exit 1
fi
if [ "$secret" != "${CRON_SECRET}" ]; then
  echo "::warning::CRON_SECRET contained line breaks or padding whitespace. Stripped it for this run, but re-save the secret as a single line -- and make sure it matches the Vercel value exactly, or the request will come back 401."
fi
if [ "$site" != "${SITE_URL}" ]; then
  echo "::warning::PICKEM_SITE_URL contained line breaks or padding whitespace. Stripped it for this run; re-save it as a single line."
fi
case "$site" in
  https://*|http://*) ;;
  *) echo "::error::PICKEM_SITE_URL must include the scheme, e.g. https://your-app.vercel.app"; exit 1 ;;
esac

interval_minutes=$(( (SWEEP_INTERVAL_SECONDS + 59) / 60 ))
endpoint="${site%/}/api/notify-reminders?nextSweepMinutes=${interval_minutes}"
[ "$DRY_RUN" = "1" ] && endpoint="${endpoint}&dryRun=1"

workdir=$(mktemp -d)
response="$workdir/response.json"

# ---------------------------------------------------------------------------
# One loop at a time: the oldest in-progress run wins. Run IDs only increase,
# so "older" is just "smaller ID". The predecessor that started this run is
# excluded -- it is in its last seconds, handing off, not looping.
# An API failure answers "no", because a duplicate sweep is harmless and a
# loop that stands down by mistake is not.
# ---------------------------------------------------------------------------
older_loop() {
  [ -n "$GITHUB_REPOSITORY" ] || return 1
  local ids
  ids=$(gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/runs?status=in_progress&per_page=50" \
          --jq '.workflow_runs[].id' 2>/dev/null) || return 1
  local id
  for id in $ids; do
    [ "$id" = "$GITHUB_RUN_ID" ] && continue
    [ -n "$HANDOFF_FROM" ] && [ "$id" = "$HANDOFF_FROM" ] && continue
    if [ "$id" -lt "$GITHUB_RUN_ID" ]; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# One sweep. Sets: http, next_kickoff ("missing" | "null" | ISO), lead_cfg.
# Returns 0 on HTTP 200, 1 on a transient failure; exits on config errors.
# ---------------------------------------------------------------------------
sweep() {
  : > "$response"
  http=$(curl -sS --max-time 60 -o "$response" -w '%{http_code}' \
    -X POST "$endpoint" \
    -H "Authorization: Bearer ${secret}" 2>"$workdir/curl.err")
  local rc=$?

  next_kickoff="missing"
  lead_cfg=75

  if [ "$rc" -ne 0 ]; then
    case "$rc" in
      43) cat "$workdir/curl.err"
          echo "::error::curl exit 43 - the Authorization header was rejected before sending. CRON_SECRET almost certainly contains a line break. Re-save it in GitHub as a single line."
          exit 1 ;;
      6)  echo "::warning::curl exit 6 - could not resolve the host in PICKEM_SITE_URL." ;;
      7)  echo "::warning::curl exit 7 - could not connect to PICKEM_SITE_URL." ;;
      28) echo "::warning::curl exit 28 - request timed out after 60s." ;;
      *)  echo "::warning::curl failed with exit $rc: $(head -c 300 "$workdir/curl.err")" ;;
    esac
    return 1
  fi

  if [ "$http" = "401" ]; then
    echo "::error::401 - CRON_SECRET here does not match the one set in Vercel. The two must be byte-identical."
    exit 1
  fi
  if [ "$http" != "200" ]; then
    echo "::warning::Reminder sweep returned HTTP $http: $(head -c 300 "$response")"
    return 1
  fi

  local notified widened names
  notified=$(jq -r '.notified // 0' "$response" 2>/dev/null || echo "?")
  widened=$(jq -r '.windowWidened // false' "$response" 2>/dev/null || echo false)
  lead_cfg=$(jq -r '.configuredLeadMinutes // 75' "$response" 2>/dev/null || echo 75)
  next_kickoff=$(jq -r 'if has("nextKickoffAt") then (.nextKickoffAt // "null") else "missing" end' \
                   "$response" 2>/dev/null || echo missing)
  names=$(jq -r '[.sent[]? | "\(.name) (\(.games))"] | join(", ")' "$response" 2>/dev/null || true)
  local failed
  failed=$(jq -r '[.failed[]? | "\(.name): \(.reason)"] | join("; ")' "$response" 2>/dev/null || true)

  if [ "$DRY_RUN" = "1" ]; then
    log "dry run: ${notified} player(s) would be pinged${names:+ - $names}; next kickoff ${next_kickoff}"
    echo "::notice::DRY RUN - nothing was sent. ${notified} player(s) would have been pinged. Run again with 'Report who would be pinged' UNCHECKED to send for real (that also starts the reminder loop)."
    jq . "$response" 2>/dev/null || cat "$response"
  else
    log "swept: pinged ${notified}${names:+ - $names}; next kickoff ${next_kickoff}"
  fi
  if [ -n "$failed" ]; then
    echo "::warning::Discord send failed for: ${failed}. Those players are retried on the next sweep."
  fi
  if [ "$widened" = "true" ]; then
    echo "::warning::The sweep widened its reminder window beyond the configured lead. Reminders still go out, but earlier than intended."
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Stay awake? Sets `why` for the log either way.
# ---------------------------------------------------------------------------
should_stay_awake() {
  local now; now=$(date -u +%s)
  case "$next_kickoff" in
    missing)
      why="endpoint did not report the next kickoff (older deploy, or the sweep failed)"
      return 0 ;;
    null)
      # Slates only reach the database when someone opens that week in the
      # app, which can be the morning of. On game days, assume one is coming.
      local dow; dow=$(TZ=America/New_York date +%u)   # 4 Thu, 5 Fri, 6 Sat
      if [ "$dow" -ge 4 ] && [ "$dow" -le 6 ]; then
        why="no upcoming games loaded yet, but it is a game day (ET)"
        return 0
      fi
      why="no upcoming games loaded and it is not a game day"
      return 1 ;;
  esac
  local kick
  if ! kick=$(date -u -d "$next_kickoff" +%s 2>/dev/null); then
    why="could not parse next kickoff '$next_kickoff'"
    return 0
  fi
  local due=$(( kick - lead_cfg * 60 ))
  local until_due=$(( due - now ))
  local horizon=$(( AWAKE_HORIZON_HOURS * 3600 ))
  if [ "$until_due" -le "$horizon" ]; then
    why="next reminder due $(date -u -d "@$due" +'%a %H:%MZ') (kickoff $(TZ=America/New_York date -d "@$kick" +'%a %-I:%M %p ET'))"
    return 0
  fi
  why="next reminder not due for $(( until_due / 3600 ))h - beyond the ${AWAKE_HORIZON_HOURS}h horizon"
  return 1
}

handoff() {
  local attempt
  for attempt in 1 2 3; do
    if gh workflow run "$WORKFLOW_FILE" --repo "$GITHUB_REPOSITORY" --ref "$GITHUB_REF_NAME" \
         -f dryRun=false -f handoffFrom="$GITHUB_RUN_ID" 2>"$workdir/gh.err"; then
      log "handed off to a fresh run"
      return 0
    fi
    log "handoff attempt $attempt failed: $(head -c 300 "$workdir/gh.err")"
    sleep 10
  done
  echo "::error::Could not start the next reminder run. The loop has stopped; the next scheduled firing will restart it, but reminders may be late until then."
  exit 1
}

# ---------------------------------------------------------------------------

if [ "$INITIAL_DELAY_SECONDS" -gt 0 ]; then
  log "waiting ${INITIAL_DELAY_SECONDS}s for the deploy to go live"
  sleep "$INITIAL_DELAY_SECONDS"
fi

if [ "$DRY_RUN" = "1" ]; then
  sweep || { echo "::error::Dry run failed (HTTP ${http:-none})."; exit 1; }
  exit 0
fi

# GitHub disables scheduled workflows in public repos after 60 days without a
# commit -- for this repo that would land mid-November, mid-season. Re-enabling
# an already-enabled workflow resets that clock, so do it once per run. Best
# effort: a failure here changes nothing about this run.
if [ -n "$GITHUB_REPOSITORY" ]; then
  gh api -X PUT "repos/${GITHUB_REPOSITORY}/actions/workflows/${WORKFLOW_FILE}/enable" >/dev/null 2>&1 \
    || log "keepalive (workflow enable) failed - harmless, but re-enable the workflow by hand if it ever shows as disabled"
fi

start=$(date -u +%s)
deadline=$(( start + RUN_BUDGET_SECONDS ))
failures=0
sweeps=0

while :; do
  if other=$(older_loop); then
    log "run $other is already looping - standing down"
    echo "::notice::Another reminder loop (run $other) is already running. Nothing to do."
    exit 0
  fi

  tick=$(date -u +%s)
  if sweep; then
    failures=0
    sweeps=$(( sweeps + 1 ))
  else
    failures=$(( failures + 1 ))
    if [ "$failures" -ge "$MAX_CONSECUTIVE_FAILURES" ]; then
      echo "::error::${failures} sweeps in a row failed (~$(( failures * SWEEP_INTERVAL_SECONDS / 60 )) min). Stopping the loop so this run shows as failed; the next scheduled firing will try again."
      exit 1
    fi
  fi

  if ! should_stay_awake; then
    log "going idle: $why"
    echo "::notice::Reminder loop idle - ${why}. A scheduled firing will wake it before the next slate."
    exit 0
  fi

  next_tick=$(( tick + SWEEP_INTERVAL_SECONDS ))
  if [ "$next_tick" -ge "$deadline" ]; then
    log "run budget spent after ${sweeps} sweep(s); staying awake because ${why}"
    handoff
    exit 0
  fi

  pause=$(( next_tick - $(date -u +%s) ))
  [ "$pause" -gt 0 ] && sleep "$pause"
done
