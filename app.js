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
let userPicks = {};      // gameId -> selection
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
  userPicks = {};
  if (!currentUser) return;
  try {
    const res = await fetch(
      `/api/picks?userName=${encodeURIComponent(currentUser)}&week=${week}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return;
    const data = await res.json();
    userPicks = data.picks || {};
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
    if (!g.isOverUnder) foot.push(`Total ${g.total}`);
    if (final && pick) {
      const o = gradePick(g, pick);
      foot.push(`<span class="outcome ${o}">${o.toUpperCase()}</span>`);
    } else if (!pick && !locked) {
      foot.push('No pick yet');
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

// Mirrors the server's grading so the card can show a result immediately.
function gradePick(game, selection) {
  if (!game.result?.completed) return 'pending';
  const { homeScore, awayScore } = game.result;
  const margin = homeScore - awayScore;
  if (selection === 'over' || selection === 'under') {
    const t = homeScore + awayScore;
    if (t === game.total) return 'push';
    return (selection === 'over' ? t > game.total : t < game.total) ? 'win' : 'loss';
  }
  const line = selection === game.home ? game.spread : -game.spread;
  if (selection === game.home) {
    return margin > -line ? 'win' : margin === -line ? 'push' : 'loss';
  }
  return margin < line ? 'win' : margin === line ? 'push' : 'loss';
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
    const o = gradePick(g, sel);
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
  populateScoreSelect();
  renderStandings();
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
  };
  document.getElementById('loadApiBtn').onclick = () => window.reloadWeek(true);
  document.getElementById('enterScoreBtn').onclick = enterScore;
  document.getElementById('deleteUserBtn').onclick = deleteUser;

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
