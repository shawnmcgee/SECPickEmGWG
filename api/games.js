// /api/games.js
const SEC_TEAMS = [
  "Alabama","Arkansas","Auburn","Florida","Georgia","Kentucky","LSU","Ole Miss",
  "Mississippi State","Missouri","Oklahoma","South Carolina","Tennessee","Texas",
  "Texas A&M","Vanderbilt"
];
const SEASON_START = new Date("2025-08-28T00:00:00-04:00"); // ET

function weekFromDate(d) {
  const ms = d - SEASON_START;
  if (ms < 0) return 1;
  const week = Math.floor(ms / (7*24*60*60*1000)) + 1;
  return Math.max(1, Math.min(15, week));
}
function weekRange(week) {
  const start = new Date(SEASON_START.getTime() + (week-1)*7*24*60*60*1000);
  const end = new Date(start.getTime() + 6*24*60*60*1000);
  return { start, end };
}
function toETParts(iso) {
  // returns {date: 'YYYY-MM-DD', time: 'HH:MM'} in America/New_York
  const opts = { timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' };
  const fmt = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date(iso));
  const get = t => fmt.find(p => p.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return { date, time };
}
function cleanTeamName(name) {
  for (const t of SEC_TEAMS) if (name.includes(t)) return t;
  return name
    .replace(/Crimson Tide|Razorbacks|Tigers|Gators|Bulldogs|Wildcats|Rebels|Volunteers|Longhorns|Aggies|Commodores|Sooners|Gamecocks/gi,'')
    .trim();
}
function transformGames(arr) {
  return arr.map(g => {
    const { date, time } = toETParts(g.commence_time);
    const homeRaw = g.home_team || '';
    const awayRaw = g.away_team || '';
    const home = cleanTeamName(homeRaw);
    const away = cleanTeamName(awayRaw);

    let spread = 0, total = 50;
    const bm = (g.bookmakers||[])[0];
    if (bm && bm.markets) {
      const sp = bm.markets.find(m => m.key === 'spreads');
      const to = bm.markets.find(m => m.key === 'totals');
      if (sp?.outcomes) {
        const homeOutcome = sp.outcomes.find(o => o.name === homeRaw);
        if (homeOutcome?.point !== undefined) spread = Number(homeOutcome.point);
      }
      if (to?.outcomes?.[0]?.point !== undefined) {
        total = Number(to.outcomes[0].point);
      }
    }

    return {
      id: g.id || `${away}@${home}_${date}_${time}`,
      home, away, spread, total, date, time,
      isOverUnder: home === 'South Carolina' || away === 'South Carolina',
      isSecMatchup: SEC_TEAMS.includes(home) && SEC_TEAMS.includes(away)
    };
  });
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let week = Number(url.searchParams.get('week'));
    if (!week) week = weekFromDate(new Date());
    week = Math.max(1, Math.min(15, week));
    const { start, end } = weekRange(week);

    const days = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {
      days.push(new Date(d));
    }

    const apiKey = process.env.ODDS_API_KEY;
    const base = 'https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds';
    const params = (isoDate) =>
      `${base}?apiKey=${apiKey}&regions=us&markets=spreads,totals&oddsFormat=american&dateFormat=iso&date=${isoDate}`;

    const results = await Promise.allSettled(days.map(async d => {
      const iso = d.toISOString().slice(0,10);
      const r = await fetch(params(iso), { timeout: 20000 });
      if (!r.ok) throw new Error(`Odds API ${r.status}`);
      return r.json();
    }));

    // flatten + filter to SEC teams
    const raw = results.flatMap(x => Array.isArray(x.value) ? x.value : [])
      .filter(g => SEC_TEAMS.some(t => (g.home_team||'').includes(t) || (g.away_team||'').includes(t)));

    // unique by team/date/time
    const seen = new Set();
    const deduped = [];
    for (const g of raw) {
      const { date, time } = toETParts(g.commence_time);
      const key = `${g.home_team}|${g.away_team}|${date}|${time}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(g); }
    }

    res.status(200).json({ week, games: transformGames(deduped) });
  } catch (e) {
    res.status(200).json({ week: null, games: [] });
  }
}
