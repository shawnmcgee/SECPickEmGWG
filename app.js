/* ===========================================================================
   SEC Pick'em — client
   Server is the source of truth for games, lines, locks and picks.
   localStorage holds only the signed-in name and a per-season display cache.
   =========================================================================== */

const SEASON = 2026;
const TEST_WEEK = 0;
const MIN_WEEK = 0;
const MAX_WEEK = 15;
const WEEK_1_DATE = { y: 2026, m: 9, d: 3 };  // Thu Sept 3 — mirrors lib/season.js

// Cache keys are namespaced by season. The old build cached under "week1",
// "week2"... with no season, so returning players opened the app in September
// and saw LAST year's games.
const cacheKey = (week) => `pickem:${SEASON}:games:w${week}`;
const USER_KEY = `pickem:user`;

// Brand colors. SEC teams arrive here already shortened by the server's
// TEAM_NAME_MAP; everyone else keeps the provider's full name ("North Carolina
// Tar Heels"), so lookup matches on a leading school name, longest key first.
const TEAM_COLORS = {
  // SEC
  'Alabama': '#9E1B32', 'Arkansas': '#9D2235', 'Auburn': '#0C2340',
  'Florida': '#0021A5', 'Georgia': '#BA0C2F', 'Kentucky': '#0033A0',
  'LSU': '#461D7C', 'Ole Miss': '#14213D', 'Mississippi State': '#660000',
  'Missouri': '#F1B82D', 'Oklahoma': '#841617', 'South Carolina': '#73000A',
  'Tennessee': '#FF8200', 'Texas': '#BF5700', 'Texas A&M': '#500000',
  'Vanderbilt': '#866D4B',

  // Week 0 (test week) opponents
  'North Carolina State': '#CC0000', 'NC State': '#CC0000',
  'North Carolina': '#7BAFD4',
  'TCU': '#4D1979', 'Texas Christian': '#4D1979',
  'USC': '#990000', 'Southern California': '#990000',
  'San Jose State': '#0055A2', 'San Jose St': '#0055A2',
  'Virginia': '#232D4B', 'Virginia Tech': '#630031',
  'Memphis': '#003087', 'UNLV': '#CF0A2C',
};

// Longest first so "North Carolina State" wins over "North Carolina",
// and "Texas A&M" over "Texas".
const COLOR_KEYS = Object.keys(TEAM_COLORS).sort((a, b) => b.length - a.length);

const normalizeName = (s) =>
  (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

function brandColor(team) {
  const t = normalizeName(team);
  if (TEAM_COLORS[t]) return TEAM_COLORS[t];
  // Word-boundary prefix match so "Texas" doesn't swallow "Texas Tech ...".
  const key = COLOR_KEYS.find((k) => t === k || t.startsWith(`${k} `));
  return key ? TEAM_COLORS[key] : '#3d3d46';
}

function luminance(hex) {
  const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.substr(i, 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const INK = '#16161a';
const INK_LUM = luminance(INK);

/**
 * Pick black or white text for a background, by WCAG contrast ratio.
 * Hardcoding white fails badly on the light brand colors: Missouri gold is
 * 1.8:1 against white, Tennessee orange 2.5:1, Carolina blue 2.4:1 -- all far
 * under the 4.5:1 minimum. Every team clears 4.5:1 once the text adapts.
 */
function readableOn(hex) {
  const lum = luminance(hex);
  const vsWhite = 1.05 / (lum + 0.05);
  const vsInk = (lum + 0.05) / (INK_LUM + 0.05);
  return vsWhite >= vsInk ? '#ffffff' : INK;
}

function colorFor(team) {
  const bg = brandColor(team);
  return { bg, fg: readableOn(bg) };
}

let currentUser = null;
let currentWeek = 1;
let weekGames = [];
let userPicks = {};      // gameId -> selection (may include unsaved edits)
let savedPicks = {};     // gameId -> selection, as last confirmed by the server
let savedLines = {};     // gameId -> the line the pick was saved at
let lockedIds = new Set();
let dirty = false;

/* --- week math (mirrors the server, DST-safe) --------------------------- */
function etOffsetMinutes(date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((x) => [x.type, x.value])
  );
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
function etMidnight(y, m, d) {
  const naive = Date.UTC(y, m - 1, d);
  return new Date(naive - etOffsetMinutes(new Date(naive + 12 * 3600000)) * 60000);
}
const rawWeekStart = (w) =>
  etMidnight(WEEK_1_DATE.y, WEEK_1_DATE.m, WEEK_1_DATE.d + (w - 1) * 7);
// Careful: `Number(w) || 1` is wrong here. Week 0 is a real week and 0 is
// falsy, so that form silently promotes the test week to week 1.
function clampWeek(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1;
  return Math.max(MIN_WEEK, Math.min(MAX_WEEK, Math.trunc(n)));
}

function weekFromDate(d = new Date()) {
  let w = Math.floor((d - rawWeekStart(1)) / (7 * 864e5)) + 1;
  if (d < rawWeekStart(w)) w -= 1;
  else if (d >= rawWeekStart(w + 1)) w += 1;
  return clampWeek(w);
}

/* --- formatting --------------------------------------------------------- */
// Always formats through Intl in America/New_York. The old build built dates
// with a hardcoded "-04:00", which put every game after Nov 1 an hour off.
function fmtKickoff(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'TBD';
  const day = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time} ET`;
}
function fmtDay(iso) {
  if (!iso) return 'Date TBD';
  return new Date(iso).toLocaleDateString('en-US', {
    timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric',
  });
}
const fmtLine = (n) => (n > 0 ? `+${n}` : `${n}`);

/* Player names are free text, and the reminder panel puts them inside
   attributes (`value="..."`, `data-name="..."`) where a stray quote would
   break out of the tag. Escape on the way in rather than trusting the input. */
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, '&quot;');

/* --- toast -------------------------------------------------------------- */
let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3400);
}

/* --- data --------------------------------------------------------------- */
async function loadGames(week, { live = false } = {}) {
  const list = document.getElementById('gamesList');
  list.innerHTML = `<div class="empty"><p>Loading week ${week}…</p></div>`;

  const url = live ? `/api/games?week=${week}` : `/api/games-history?week=${week}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    if ((!data.games || data.games.length === 0) && !live) {
      // Nothing stored for this week yet — go get it from the provider.
      return loadGames(week, { live: true });
    }

    weekGames = data.games || [];
    lockedIds = new Set(weekGames.filter((g) => g.locked).map((g) => g.id));
    try { sessionStorage.setItem(cacheKey(week), JSON.stringify(weekGames)); } catch {}
    return weekGames;
  } catch (err) {
    // Fall back to the cached copy so the app still renders offline.
    let cached = [];
    try { cached = JSON.parse(sessionStorage.getItem(cacheKey(week)) || '[]'); } catch {}
    weekGames = cached;
    if (cached.length) toast('Showing cached games — could not reach the server', true);
    else list.innerHTML = `<div class="empty"><p>Could not load week ${week}.</p>
      <button onclick="window.reloadWeek()">Try again</button></div>`;
    return weekGames;
  }
}

// Picks always come from the server, never from local state, so a player sees
// the same selections on their phone and their laptop.
async function loadPicks(week) {
  userPicks = {}; savedPicks = {}; savedLines = {};
  if (!currentUser) return;
  try {
    const res = await fetch(
      `/api/picks?userName=${encodeURIComponent(currentUser)}&week=${week}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return;
    const data = await res.json();
    userPicks = data.picks || {};
    savedPicks = { ...userPicks };
    savedLines = data.lines || {};
    Object.entries(data.locked || {}).forEach(([id, l]) => { if (l) lockedIds.add(id); });
  } catch (err) {
    console.error('Could not load picks:', err);
    toast('Could not load your saved picks', true);
  }
}

async function savePicks() {
  if (!currentUser) { toast('Sign in first'); return false; }
  const picks = Object.entries(userPicks)
    .filter(([gameId]) => !lockedIds.has(gameId))
    .map(([gameId, selection]) => ({ gameId, selection }));
  if (picks.length === 0) { toast('Make at least one pick first'); return false; }

  try {
    const res = await fetch('/api/picks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No `games` payload: the server reads lines from its own table.
      body: JSON.stringify({ userName: currentUser, week: currentWeek, picks }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    if (data.rejected?.length) {
      toast(`Saved ${data.saved}. ${data.rejected.length} rejected (${data.rejected[0].reason}).`, true);
    } else {
      toast(`Saved ${data.saved} pick${data.saved === 1 ? '' : 's'}`);
    }
    dirty = false;
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

/* --- rendering ---------------------------------------------------------- */
function render() {
  const list = document.getElementById('gamesList');
  const submit = document.getElementById('submitPicks');

  if (!weekGames.length) {
    list.innerHTML = `<div class="empty"><p>No games loaded for week ${currentWeek}.</p>
      <button onclick="window.reloadWeek(true)">Load live lines</button></div>`;
    submit.hidden = true;
    updateSummary();
    return;
  }

  let html = '';
  let lastDay = null;

  weekGames.forEach((g) => {
    const day = fmtDay(g.kickoffAt);
    if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }

    const locked = g.locked || lockedIds.has(g.id);
    const final = g.result?.completed;
    const pick = userPicks[g.id];
    const home = colorFor(g.home);

    const tags = [];
    if (g.isSecMatchup) tags.push('<span class="tag">SEC</span>');
    if (g.isOverUnder) tags.push('<span class="tag ou">Over / Under only</span>');
    if (final) tags.push('<span class="tag final">Final</span>');
    else if (locked) tags.push('<span class="tag lock">Locked</span>');

    const headRight = final
      ? `${g.away} ${g.result.awayScore} – ${g.result.homeScore} ${g.home}`
      : fmtKickoff(g.kickoffAt);

    let body;
    if (g.isOverUnder) {
      body = `
        <div class="row" style="cursor:default;padding-bottom:2px">
          <span class="team" style="font-size:17px"><span>${g.away} at ${g.home}</span></span>
        </div>
        <div class="ourow">
          ${['over', 'under'].map((side) => `
            <button class="ou" style="--c:${home.bg};--fg:${home.fg}" data-game="${g.id}" data-pick="${side}"
              aria-pressed="${pick === side}" ${locked ? 'disabled' : ''}>
              <b>${side}</b><i>${g.total}</i>
            </button>`).join('')}
        </div>`;
    } else {
      const row = (team, line) => {
        const c = colorFor(team);
        return `
        <button class="row" style="--c:${c.bg};--fg:${c.fg}" data-game="${g.id}" data-pick="${team}"
          aria-pressed="${pick === team}" ${locked ? 'disabled' : ''}>
          <span class="team"><i class="mark"></i><span>${team}</span></span>
          <span class="num">${fmtLine(line)}</span>
        </button>`;
      };
      body = row(g.away, -g.spread) + row(g.home, g.spread);
    }

    const foot = [];
    if (!g.isOverUnder) foot.push(`<span>Total ${g.total}</span>`);
    if (pick && savedPicks[g.id] !== pick) {
      foot.push('<span class="unsaved">Not saved yet</span>');
    } else if (pick) {
      const note = lockedNote(g, pick);
      if (note) foot.push(note);
    }
    if (final && pick) {
      const o = gradePick(g, pick, savedLines[g.id]);
      foot.push(`<span class="outcome ${o}">${o.toUpperCase()}</span>`);
    } else if (!pick && !locked) {
      foot.push('<span>No pick yet</span>');
    }

    html += `
      <article class="card ${locked ? 'locked' : ''}" style="--h:${home.bg}">
        <div class="chead">${tags.join('')}<span class="ctime">${headRight}</span></div>
        ${body}
        ${foot.length ? `<div class="cfoot">${foot.join('')}</div>` : ''}
      </article>`;
  });

  list.innerHTML = html;
  list.querySelectorAll('[data-game]').forEach((btn) => {
    btn.addEventListener('click', onPick);
  });

  const anyOpen = weekGames.some((g) => !(g.locked || lockedIds.has(g.id)));
  submit.hidden = !currentUser || !anyOpen;
  updateSummary();
}

/**
 * Mirrors the server's grading. `lockedLine` is the value stored in picks.line
 * at submit time -- the number standings actually score against. Falls back to
 * the game's current line only for picks that were never saved.
 */
function gradePick(game, selection, lockedLine) {
  if (!game.result?.completed) return 'pending';
  const { homeScore, awayScore } = game.result;
  const stored = Number.isFinite(Number(lockedLine)) && lockedLine !== null
    ? Number(lockedLine) : null;

  if (selection === 'over' || selection === 'under') {
    const total = stored ?? game.total;
    const t = homeScore + awayScore;
    if (t === total) return 'push';
    return (selection === 'over' ? t > total : t < total) ? 'win' : 'loss';
  }

  const margin = homeScore - awayScore;
  const line = stored ?? (selection === game.home ? game.spread : -game.spread);
  if (selection === game.home) {
    return margin > -line ? 'win' : margin === -line ? 'push' : 'loss';
  }
  return margin < line ? 'win' : margin === line ? 'push' : 'loss';
}

/** What line is this pick actually locked at, and has the market moved since? */
function lockedNote(game, selection) {
  const raw = savedLines[game.id];
  if (raw === undefined || raw === null || !Number.isFinite(Number(raw))) return '';
  const stored = Number(raw);
  const isTotal = selection === 'over' || selection === 'under';
  const current = isTotal
    ? Number(game.total)
    : Number(selection === game.home ? game.spread : -game.spread);
  const show = (n) => (isTotal ? `${n}` : fmtLine(n));
  const label = isTotal ? 'Locked O/U' : 'Locked at';

  if (current === stored) return `<span class="locked-line">${label} ${show(stored)}</span>`;
  // Grading uses the stored number, so flag the gap rather than hide it.
  return `<span class="line-moved">${label} ${show(stored)} · now ${show(current)}</span>`;
}

function onPick(e) {
  const btn = e.currentTarget;
  const gameId = btn.dataset.game;
  if (lockedIds.has(gameId)) return;
  userPicks[gameId] = btn.dataset.pick;
  dirty = true;

  document.querySelectorAll(`[data-game="${CSS.escape(gameId)}"]`).forEach((el) => {
    el.setAttribute('aria-pressed', String(el === btn));
  });
  updateSummary();
}

function updateSummary() {
  const box = document.getElementById('pickSummary');
  const text = document.getElementById('summaryText');
  const rec = document.getElementById('summaryRecord');
  if (!currentUser || !weekGames.length) { box.hidden = true; return; }

  const made = weekGames.filter((g) => userPicks[g.id]).length;
  text.textContent = `${made} of ${weekGames.length} games picked`;

  let w = 0, l = 0, p = 0;
  weekGames.forEach((g) => {
    const sel = userPicks[g.id];
    if (!sel || !g.result?.completed) return;
    const o = gradePick(g, sel, savedLines[g.id]);
    if (o === 'win') w++; else if (o === 'loss') l++; else if (o === 'push') p++;
  });
  rec.textContent = w + l + p > 0 ? `${w}-${l}${p ? `-${p}` : ''}` : '';
  box.hidden = false;
}

async function renderStandings() {
  const paint = (el, rows, showPct) => {
    if (!rows?.length) { el.innerHTML = '<li class="st-empty">No graded picks yet</li>'; return; }
    el.innerHTML = rows.map((s, i) => `
      <li class="${s.name === currentUser ? 'me' : ''}">
        <span class="st-rank">${i + 1}</span>
        <span>${s.name}</span>
        <span class="st-rec">${s.record}${showPct && s.winPercentage ? ` · ${s.winPercentage}%` : ''}</span>
      </li>`).join('');
  };

  try {
    const [wk, szn] = await Promise.all([
      fetch(`/api/standings?week=${currentWeek}`).then((r) => r.json()),
      fetch(`/api/standings`).then((r) => r.json()),
    ]);
    paint(document.getElementById('weeklyStandings'), wk.standings, false);
    paint(document.getElementById('seasonStandings'), szn.standings, true);
  } catch (err) {
    console.error('Standings failed:', err);
  }
}

function populateScoreSelect() {
  const sel = document.getElementById('gameIdForScore');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select a game…</option>' +
    weekGames.map((g) => `<option value="${g.id}">${g.away} at ${g.home}${g.result?.completed ? ' (final)' : ''}</option>`).join('');
}

/* --- pick status (commissioner) ----------------------------------------- */
let reminderNames = [];

async function loadPickStatus() {
  const box = document.getElementById('pickStatus');
  const hint = document.getElementById('statusHint');
  if (!box) return;
  box.innerHTML = '<p class="hint">Checking…</p>';

  try {
    const res = await fetch(`/api/status?week=${currentWeek}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    reminderNames = data.summary.needsReminder;

    if (!data.players.length) {
      box.innerHTML = '<p class="hint">No players yet.</p>';
      return;
    }
    if (data.totalGames === 0) {
      box.innerHTML = `<p class="hint">No games loaded for week ${currentWeek} yet.</p>`;
      return;
    }

    const label = { complete: 'Complete', partial: 'Partial', none: 'No picks' };
    box.innerHTML =
      data.players.map((p) => `
        <div class="status-row">
          <span>${p.name}${p.remindersOn ? '<span class="status-bell" title="Discord reminders on">\u{1F514}</span>' : ''}${p.noPicksThisSeason ? '<em class="status-note">no picks this season</em>' : ''}</span>
          <span class="status-count">${p.picked}/${data.totalGames}</span>
          <span class="status-badge ${p.state}">${label[p.state]}</span>
        </div>`).join('') +
      `<div class="status-tally">
        ${data.summary.complete} complete · ${data.summary.partial} partial ·
        ${data.summary.none} none · ${data.openGames} of ${data.totalGames} games still open
      </div>`;

    hint.textContent = data.nextKickoff
      ? `Next lock ${fmtKickoff(data.nextKickoff)}. Counts only — never shows picks.`
      : 'All games for this week are locked.';
  } catch (err) {
    box.innerHTML = `<p class="hint">Could not load status: ${err.message}</p>`;
  }
}

async function copyReminderNames() {
  if (!reminderNames.length) return toast('Everyone is fully picked');
  const text = reminderNames.join(', ');
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${reminderNames.length} name${reminderNames.length === 1 ? '' : 's'}`);
  } catch {
    // Clipboard needs HTTPS and a user gesture; fall back to showing the list.
    toast(text);
  }
}

/* --- score sync (fetch, review, confirm) -------------------------------- */
const SYNC_LABEL = {
  ready: 'New final', differs: 'Differs from saved', unchanged: 'Already saved',
  in_progress: 'In progress', not_started: 'Not started',
  no_scores: 'No scores yet', not_found: 'Not in feed',
};

async function fetchScores() {
  const pw = document.getElementById('adminPassword').value;
  if (!pw) return toast('Admin password required', true);
  const box = document.getElementById('scoreProposals');
  const apply = document.getElementById('applyScoresBtn');
  box.innerHTML = '<p class="hint">Fetching…</p>';
  apply.hidden = true;

  try {
    const res = await fetch('/api/scores-sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: pw, week: currentWeek, mode: 'preview' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fetch failed');

    if (!data.proposals?.length) {
      box.innerHTML = `<p class="hint">${data.note || 'Nothing returned for this week.'}</p>`;
      return;
    }

    // Only games with a usable final are editable and selected by default.
    box.innerHTML = data.proposals.map((p) => {
      const actionable = p.status === 'ready' || p.status === 'differs';
      const prior = p.existing ? ` (saved ${p.existing.awayScore}-${p.existing.homeScore})` : '';
      return `
        <div class="proposal ${actionable ? '' : 'inert'}">
          <label class="proposal-pick">
            <input type="checkbox" data-sync="${p.gameId}" ${actionable ? 'checked' : 'disabled'}>
            <span class="proposal-teams">${p.away} at ${p.home}</span>
          </label>
          <span class="proposal-scores">
            ${actionable
              ? `<input type="number" inputmode="numeric" min="0" class="ps" data-away="${p.gameId}" value="${p.awayScore}">
                 <em>–</em>
                 <input type="number" inputmode="numeric" min="0" class="ps" data-home="${p.gameId}" value="${p.homeScore}">`
              : '<span class="proposal-dash">—</span>'}
          </span>
          <span class="proposal-status ${p.status}">${SYNC_LABEL[p.status] || p.status}${prior}</span>
        </div>`;
    }).join('');

    const s = data.summary;
    const warn = data.beyondWindow
      ? ' Some games are older than the provider\'s 3-day window and can only be entered by hand.'
      : '';
    document.getElementById('syncHint').textContent =
      `${s.ready} new, ${s.differs} differ, ${s.unchanged} already saved, ${s.pending} not final yet.` +
      (data.quotaRemaining ? ` Quota left: ${data.quotaRemaining}.` : '') + warn;

    apply.hidden = s.ready + s.differs === 0;
  } catch (err) {
    box.innerHTML = `<p class="hint">${err.message}</p>`;
  }
}

async function applyScores() {
  const pw = document.getElementById('adminPassword').value;
  const boxes = [...document.querySelectorAll('[data-sync]:checked')];
  if (!boxes.length) return toast('Nothing selected');

  const scores = boxes.map((b) => {
    const id = b.dataset.sync;
    const esc = CSS.escape(id);
    return {
      gameId: id,
      awayScore: Number(document.querySelector(`[data-away="${esc}"]`).value),
      homeScore: Number(document.querySelector(`[data-home="${esc}"]`).value),
    };
  });

  try {
    const res = await fetch('/api/scores-sync', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // The server writes exactly what is confirmed here, not what it fetched,
      // so any edit made in the review list is what lands.
      body: JSON.stringify({ adminPassword: pw, week: currentWeek, mode: 'apply', scores }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    toast(`Saved ${data.applied} score${data.applied === 1 ? '' : 's'}` +
      (data.skipped?.length ? `, ${data.skipped.length} skipped` : ''));
    document.getElementById('scoreProposals').innerHTML = '';
    document.getElementById('applyScoresBtn').hidden = true;

    await loadGames(currentWeek);
    await loadPicks(currentWeek);
    render(); renderStandings(); populateScoreSelect(); loadPickStatus();
  } catch (err) {
    toast(err.message, true);
  }
}

/* --- week navigation ---------------------------------------------------- */
async function goToWeek(week) {
  if (dirty && !confirm('You have unsaved picks. Leave this week anyway?')) return;
  currentWeek = clampWeek(week);
  dirty = false;

  const isTest = currentWeek === TEST_WEEK;
  document.getElementById('weekLabel').textContent = isTest ? 'Test week' : `Week ${currentWeek}`;
  document.getElementById('testBanner').hidden = !isTest;
  document.getElementById('prevWeek').disabled = currentWeek === MIN_WEEK;
  document.getElementById('nextWeek').disabled = currentWeek === MAX_WEEK;

  await loadGames(currentWeek);
  await loadPicks(currentWeek);
  render();
  updateDeadline();
  const proposals = document.getElementById('scoreProposals');
  if (proposals) { proposals.innerHTML = ''; document.getElementById('applyScoresBtn').hidden = true; }
  populateScoreSelect();
  renderStandings();
  if (!document.getElementById('adminSection').hidden) loadPickStatus();
}

function updateDeadline() {
  const el = document.getElementById('deadline');
  const open = weekGames.filter((g) => !(g.locked || lockedIds.has(g.id)) && g.kickoffAt);
  if (!open.length) { el.textContent = weekGames.length ? 'All games locked' : ''; el.classList.add('locked'); return; }
  const next = open.reduce((a, b) => (a.kickoffAt < b.kickoffAt ? a : b));
  el.textContent = `First lock ${fmtKickoff(next.kickoffAt)}`;
  el.classList.remove('locked');
}

/* --- auth (name only — this is a private league, not real auth) ---------- */
function signIn(name) {
  currentUser = name.trim().slice(0, 40);
  if (!currentUser) return;
  localStorage.setItem(USER_KEY, currentUser);
  document.getElementById('loginModal').hidden = true;
  const chip = document.getElementById('userChip');
  chip.textContent = currentUser;
  chip.hidden = false;
  goToWeek(currentWeek);
}
function signOut() {
  if (!confirm('Sign out?')) return;
  currentUser = null; userPicks = {};
  localStorage.removeItem(USER_KEY);
  document.getElementById('userChip').hidden = true;
  document.getElementById('loginModal').hidden = false;
}

/* --- discord reminders (commissioner) ----------------------------------- */
/*
 * Settings only. The reminders themselves are sent server-side by
 * /api/notify-reminders on a schedule -- no browser needs to be open.
 *
 * Commissioner-gated because a Discord ID points at a real person's account:
 * the app's name-only identity is fine for picks, but not for deciding who
 * gets pinged.
 */
function adminPw() {
  return document.getElementById('adminPassword').value;
}

async function loadNotifySettings() {
  const box = document.getElementById('notifyList');
  const saveBtn = document.getElementById('saveNotifyBtn');
  const pw = adminPw();
  if (!pw) return toast('Enter the commissioner password first', true);

  box.innerHTML = '<p class="hint">Loading…</p>';
  saveBtn.hidden = true;

  try {
    const res = await fetch('/api/notify-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: pw, action: 'list' }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    if (!data.players.length) {
      box.innerHTML = '<p class="hint">No players yet.</p>';
      return;
    }

    box.innerHTML = data.players.map((p) => `
      <div class="notify-row" data-name="${escapeAttr(p.userName)}">
        <span class="notify-name">${escapeHtml(p.userName)}</span>
        <input type="text" class="notify-id" inputmode="numeric"
               maxlength="20" placeholder="Discord user ID" autocomplete="off"
               aria-label="Discord user ID for ${escapeAttr(p.userName)}"
               value="${escapeAttr(p.discordUserId)}">
        <label class="notify-switch">
          <input type="checkbox" class="notify-on" ${p.notifyEnabled ? 'checked' : ''}>
          <span>Ping</span>
        </label>
        <button type="button" class="notify-test">Test</button>
      </div>`).join('');

    box.querySelectorAll('.notify-test').forEach((btn) => {
      btn.onclick = () => sendTestPing(btn.closest('.notify-row'));
    });
    saveBtn.hidden = false;
  } catch (err) {
    box.innerHTML = `<p class="hint">Could not load reminder settings: ${escapeHtml(err.message)}</p>`;
  }
}

/*
 * Sends a real message to the channel using the ID typed into the row, so it
 * can be verified before saving. The server builds it with the same function
 * the live sweep uses -- only the slate is invented.
 */
async function sendTestPing(row) {
  const pw = adminPw();
  if (!pw) return toast('Enter the commissioner password first', true);

  const btn = row.querySelector('.notify-test');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    const res = await fetch('/api/notify-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        adminPassword: pw,
        action: 'test',
        userName: row.dataset.name,
        discordUserId: row.querySelector('.notify-id').value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Test failed');
    toast(`Test ping sent for ${data.sentTo}`);

    // Show the wording inline too -- checking it should not mean tabbing to
    // Discord and back.
    let preview = row.nextElementSibling;
    if (!preview?.classList.contains('notify-preview')) {
      preview = document.createElement('pre');
      preview.className = 'notify-preview';
      row.after(preview);
    }
    preview.textContent = data.content;
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test';
  }
}

async function saveNotifySettings() {
  const pw = adminPw();
  if (!pw) return toast('Enter the commissioner password first', true);

  const settings = [...document.querySelectorAll('.notify-row')].map((row) => ({
    userName: row.dataset.name,
    discordUserId: row.querySelector('.notify-id').value.trim(),
    notifyEnabled: row.querySelector('.notify-on').checked,
  }));
  if (!settings.length) return toast('Load the settings first', true);

  try {
    const res = await fetch('/api/notify-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminPassword: pw, action: 'save', settings }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    toast(`Saved reminders for ${data.saved} player${data.saved === 1 ? '' : 's'}`);
    loadPickStatus();
  } catch (err) {
    toast(err.message, true);
  }
}

/* --- admin -------------------------------------------------------------- */
async function enterScore() {
  const gameId = document.getElementById('gameIdForScore').value;
  const homeScore = document.getElementById('homeScore').value;
  const awayScore = document.getElementById('awayScore').value;
  const adminPassword = document.getElementById('adminPassword').value;
  if (!gameId || homeScore === '' || awayScore === '' || !adminPassword) {
    return toast('Game, both scores and the password are required', true);
  }
  try {
    const res = await fetch('/api/results', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, homeScore: +homeScore, awayScore: +awayScore, adminPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    toast('Score saved');
    document.getElementById('homeScore').value = '';
    document.getElementById('awayScore').value = '';
    await loadGames(currentWeek); await loadPicks(currentWeek);
    render(); renderStandings();
  } catch (err) { toast(err.message, true); }
}

async function deleteUser() {
  const userName = document.getElementById('userToDelete').value.trim();
  const adminPassword = document.getElementById('adminPassword').value;
  if (!userName || !adminPassword) return toast('Name and password required', true);
  if (!confirm(`Delete ${userName} and all their picks?`)) return;
  try {
    const res = await fetch('/api/picks', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName, adminPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    toast(`Deleted ${userName}`);
    document.getElementById('userToDelete').value = '';
    renderStandings();
    loadPickStatus();
  } catch (err) { toast(err.message, true); }
}

/* --- boot --------------------------------------------------------------- */
window.reloadWeek = async (live = false) => {
  await loadGames(currentWeek, { live });
  await loadPicks(currentWeek);
  render(); updateDeadline(); populateScoreSelect();
};

function init() {
  document.getElementById('seasonLabel').textContent = SEASON;
  currentWeek = weekFromDate();

  document.getElementById('prevWeek').onclick = () => goToWeek(currentWeek - 1);
  document.getElementById('nextWeek').onclick = () => goToWeek(currentWeek + 1);
  document.getElementById('submitPicks').onclick = async () => {
    const ok = await savePicks();
    if (ok) { await loadPicks(currentWeek); render(); renderStandings(); }
  };
  document.getElementById('userChip').onclick = signOut;

  document.getElementById('loginBtn').onclick = () =>
    signIn(document.getElementById('nameInput').value);
  document.getElementById('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') signIn(e.target.value);
  });
  document.getElementById('adminToggle').onclick = () => {
    const b = document.getElementById('adminSection');
    b.hidden = !b.hidden;
    if (!b.hidden) loadPickStatus();
  };
  document.getElementById('refreshStatusBtn').onclick = loadPickStatus;
  document.getElementById('copyReminderBtn').onclick = copyReminderNames;
  document.getElementById('loadApiBtn').onclick = () => window.reloadWeek(true);
  document.getElementById('enterScoreBtn').onclick = enterScore;
  document.getElementById('fetchScoresBtn').onclick = fetchScores;
  document.getElementById('applyScoresBtn').onclick = applyScores;
  document.getElementById('deleteUserBtn').onclick = deleteUser;
  document.getElementById('loadNotifyBtn').onclick = loadNotifySettings;
  document.getElementById('saveNotifyBtn').onclick = saveNotifySettings;

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  const saved = localStorage.getItem(USER_KEY);
  if (saved) {
    currentUser = saved;
    const chip = document.getElementById('userChip');
    chip.textContent = saved; chip.hidden = false;
      goToWeek(currentWeek);
  } else {
    document.getElementById('loginModal').hidden = false;
    goToWeek(currentWeek);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else { init(); }
