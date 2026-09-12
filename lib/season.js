// /lib/season.js
// Single source of truth for the season. Rolling to a new year should only
// ever mean editing this file.

export const SEASON = 2026;

// 2026 CFB Week 1 opens Thursday, Sept 3 (first full Saturday is Sept 5).
// Weeks run Thursday 00:00 ET -> the following Wednesday 23:59 ET.
export const WEEK_1_START = '2026-09-03T00:00:00-04:00';

// ---------------------------------------------------------------------------
// Week 0 is a TEST week.
//   * It falls out of the same anchor: WEEK_1_START minus 7 days
//     (Thu Aug 27 -> Wed Sep 2, 2026), which is exactly the real Week 0 window.
//   * No SEC team plays Week 0 in 2026, so SEC filtering is skipped for it --
//     otherwise there would be no games to test against.
//   * It never counts toward season standings. See SCORING_MIN_WEEK.
//   * Its rows live under (season, week) = (2026, 0), so nothing overwrites
//     them when Week 1 starts and nothing needs cleaning up.
// Heads up for next year: the NCAA voted to standardize on a 14-week season
// from 2027 and drop Week 0, so this will need revisiting.
// ---------------------------------------------------------------------------
export const TEST_WEEK = 0;
export const MIN_WEEK = 0;
export const MAX_WEEK = 15;

// Weeks below this are excluded from standings.
export const SCORING_MIN_WEEK = 1;

export const isTestWeek = (week) => Number(week) === TEST_WEEK;

// League house rule: these teams are picked over/under only, never the spread.
export const OU_ONLY_TEAMS = ['South Carolina'];

export const TEAM_NAME_MAP = {
  'Alabama Crimson Tide': 'Alabama',
  'Arkansas Razorbacks': 'Arkansas',
  'Auburn Tigers': 'Auburn',
  'Florida Gators': 'Florida',
  'Georgia Bulldogs': 'Georgia',
  'Kentucky Wildcats': 'Kentucky',
  'LSU Tigers': 'LSU',
  'Ole Miss Rebels': 'Ole Miss',
  'Mississippi State Bulldogs': 'Mississippi State',
  'Missouri Tigers': 'Missouri',
  'Oklahoma Sooners': 'Oklahoma',
  'South Carolina Gamecocks': 'South Carolina',
  'Tennessee Volunteers': 'Tennessee',
  'Texas Longhorns': 'Texas',
  'Texas A&M Aggies': 'Texas A&M',
  'Vanderbilt Commodores': 'Vanderbilt',
};

export const SEC_TEAMS_FULL = Object.keys(TEAM_NAME_MAP);
export const SEC_TEAMS_SHORT = Object.values(TEAM_NAME_MAP);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Anchor as a calendar date rather than an instant. Adding 7 * 24h to a fixed
// instant drifts by an hour once DST ends on Nov 1, which pushed every week
// boundary from Thursday 00:00 back to Wednesday 23:00.
const WEEK_1_DATE = { y: 2026, m: 9, d: 3 };

/** Minutes ET is offset from UTC at a given instant (-240 EDT, -300 EST). */
function etOffsetMinutes(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}

/** The instant of midnight ET on a given ET calendar date. */
function etMidnight(y, m, d) {
  const naive = Date.UTC(y, m - 1, d);
  // Probe near midday to land on the right side of any DST transition.
  const offset = etOffsetMinutes(new Date(naive + 12 * 3600000));
  return new Date(naive - offset * 60000);
}

export function clampWeek(week) {
  const n = Number(week);
  if (!Number.isFinite(n)) return SCORING_MIN_WEEK;
  return Math.max(MIN_WEEK, Math.min(MAX_WEEK, Math.trunc(n)));
}

/** Midnight ET on the Thursday that opens the given week. Not clamped. */
function rawWeekStart(week) {
  return etMidnight(WEEK_1_DATE.y, WEEK_1_DATE.m, WEEK_1_DATE.d + (week - 1) * 7);
}

/** Midnight ET on the Thursday that opens the given week. Works for week 0. */
function weekStart(week) {
  return rawWeekStart(clampWeek(week));
}

/**
 * Which week does a given instant fall in?
 * Real Thursday-to-Thursday ET boundaries, so there is no special-cased
 * "short week 1" like the old code had.
 */
export function weekFromDate(d = new Date()) {
  // Walk from the anchor rather than dividing, so DST shifts don't accumulate.
  let week = Math.floor((d.getTime() - rawWeekStart(1).getTime()) / WEEK_MS) + 1;
  if (d.getTime() < rawWeekStart(week).getTime()) week -= 1;
  else if (d.getTime() >= rawWeekStart(week + 1).getTime()) week += 1;
  return clampWeek(week);
}

/** [start, end] window for a week, as Date objects. Works for week 0. */
export function weekRange(week) {
  const w = clampWeek(week);
  // rawWeekStart, not weekStart: clamping the +1 would make the final week's
  // end land before its own start.
  return { start: rawWeekStart(w), end: new Date(rawWeekStart(w + 1).getTime() - 1000) };
}

export function getShortTeamName(fullName) {
  if (!fullName) return '';
  return TEAM_NAME_MAP[fullName] || fullName;
}

export function isSecTeam(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return SEC_TEAMS_FULL.some((t) => t.toLowerCase() === lower);
}

export function isOverUnderOnly(home, away) {
  return OU_ONLY_TEAMS.includes(home) || OU_ONLY_TEAMS.includes(away);
}

/**
 * ET date/time parts for display. Uses Intl so DST is handled -- do not
 * hardcode -04:00, it puts every November and December game an hour off.
 */
export function toETParts(iso) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t) => fmt.find((p) => p.type === t)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Friendly ET kickoff for Discord messages: "Sat 3:30 PM ET".
 * toETParts is 24-hour and built for the games table; this is for humans.
 */
export function formatKickoffET(iso) {
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
  return `${s} ET`;
}
