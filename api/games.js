// /api/games.js
import { sql } from '../lib/db';
import {
  SEASON,
  clampWeek,
  weekFromDate,
  weekRange,
  getShortTeamName,
  isSecTeam,
  isOverUnderOnly,
  isTestWeek,
  toETParts,
} from '../lib/season';

function transformGames(arr) {
  return arr
    .map((g) => {
      const homeRaw = g.home_team || '';
      const awayRaw = g.away_team || '';
      const home = getShortTeamName(homeRaw);
      const away = getShortTeamName(awayRaw);
      const { date, time } = toETParts(g.commence_time);

      // Only take a game if the book actually posted both markets. The old
      // `spread === 0 && total === 50` sentinel silently dropped legitimate
      // pick'em games that happened to have a total of 50.
      const bm = (g.bookmakers || [])[0];
      const spreadMarket = bm?.markets?.find((m) => m.key === 'spreads');
      const totalMarket = bm?.markets?.find((m) => m.key === 'totals');
      if (!spreadMarket || !totalMarket) return null;

      const homeOutcome = spreadMarket.outcomes?.find((o) => o.name === homeRaw);
      const totalOutcome = totalMarket.outcomes?.[0];
      if (homeOutcome?.point === undefined || totalOutcome?.point === undefined) {
        return null;
      }

      return {
        id: g.id || `${away}@${home}_${date}_${time}`,
        home,
        away,
        spread: Number(homeOutcome.point),
        total: Number(totalOutcome.point),
        date,
        time,
        kickoffAt: g.commence_time,
        originalHomeTeam: homeRaw,
        originalAwayTeam: awayRaw,
        isOverUnder: isOverUnderOnly(home, away),
        isSecMatchup: isSecTeam(homeRaw) && isSecTeam(awayRaw),
      };
    })
    .filter(Boolean);
}

async function persistGames(games, week) {
  if (!sql || games.length === 0) return;
  // The server owns the lines. Picks are graded against this table, so it must
  // never be written from a client payload.
  await Promise.all(
    games.map(async (g) => {
      try {
        await sql`
          INSERT INTO games (
            id, season, week, home_team, away_team, spread, total,
            game_date, game_time, kickoff_at, is_over_under, is_sec_matchup,
            original_home_team, original_away_team
          )
          VALUES (
            ${g.id}, ${SEASON}, ${week}, ${g.home}, ${g.away}, ${g.spread}, ${g.total},
            ${g.date}, ${g.time}, ${g.kickoffAt}, ${g.isOverUnder}, ${g.isSecMatchup},
            ${g.originalHomeTeam}, ${g.originalAwayTeam}
          )
          ON CONFLICT (id) DO UPDATE SET
            spread     = EXCLUDED.spread,
            total      = EXCLUDED.total,
            game_date  = EXCLUDED.game_date,
            game_time  = EXCLUDED.game_time,
            kickoff_at = EXCLUDED.kickoff_at
          -- Never move a line once the game has kicked off.
          WHERE games.kickoff_at IS NULL OR games.kickoff_at > NOW()
        `;
      } catch (e) {
        console.error(`Failed to persist game ${g.id}:`, e.message);
      }
    })
  );
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let week = 1;
  try {
    const url = new URL(req.url, 'http://localhost');
    const requested = url.searchParams.get('week');
    week = requested ? clampWeek(requested) : weekFromDate(new Date());

    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Odds API key not configured', week, games: [] });
    }

    const { start, end } = weekRange(week);
    const apiUrl = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/');
    apiUrl.searchParams.set('apiKey', apiKey);
    apiUrl.searchParams.set('regions', 'us');
    apiUrl.searchParams.set('markets', 'spreads,totals');
    apiUrl.searchParams.set('oddsFormat', 'american');
    apiUrl.searchParams.set('dateFormat', 'iso');
    apiUrl.searchParams.set('bookmakers', 'draftkings');
    apiUrl.searchParams.set('commenceTimeFrom', start.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    apiUrl.searchParams.set('commenceTimeTo', end.toISOString().replace(/\.\d{3}Z$/, 'Z'));

    const response = await fetch(apiUrl.toString(), {
      headers: { 'User-Agent': `SEC-Pickem/${SEASON}`, Accept: 'application/json' },
    });

    if (!response.ok) {
      // Log detail server-side only. Never echo the upstream URL to the client:
      // it carries ODDS_API_KEY as a query parameter.
      console.error(`Odds API ${response.status}: ${await response.text()}`);
      return res.status(502).json({
        error: `Odds provider returned ${response.status}`,
        week,
        games: [],
      });
    }

    const data = await response.json();

    // Week 0 is the test week. No SEC team plays it in 2026, so filtering to
    // SEC would return an empty slate and leave nothing to test against.
    const relevant = isTestWeek(week)
      ? data
      : data.filter((g) => isSecTeam(g.home_team) || isSecTeam(g.away_team));

    const seen = new Set();
    const games = transformGames(relevant)
      .filter((g) => {
        const key = `${g.home}|${g.away}|${g.date}|${g.time}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt))
      // Keep the test week small; we only need a couple of games to verify.
      .slice(0, isTestWeek(week) ? 4 : undefined);

    await persistGames(games, week);

    // Cache at the edge so the whole league refreshing on Saturday morning does
    // not burn the odds-api quota. Lines move slowly enough that 60s is fine.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({
      week,
      season: SEASON,
      testWeek: isTestWeek(week),
      games,
      count: games.length,
      source: 'api',
    });
  } catch (error) {
    console.error('Games API error:', error);
    return res.status(500).json({ error: 'Failed to load games', week, games: [] });
  }
}
