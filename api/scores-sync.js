// /api/scores-sync.js
// Two-step score entry: `preview` proposes finals from the odds provider,
// `apply` writes only what the commissioner confirmed back.
//
// Matching is by event id, not team name. The games table stores the
// provider's own id, so there is no fuzzy name matching to get wrong.
import { sql } from '../lib/db';
import { SEASON, clampWeek } from '../lib/season';

const SPORT = 'americanfootball_ncaaf';
const MAX_DAYS_FROM = 3; // provider limit

function readBody(req) {
  if (!req.body) return {};
  return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
}

function checkAdmin(adminPassword) {
  // Note the first clause: without it, an unset ADMIN_PASSWORD env var makes
  // `undefined !== undefined` false and lets an empty password through.
  if (!process.env.ADMIN_PASSWORD) return 'Admin password is not configured on the server';
  if (adminPassword !== process.env.ADMIN_PASSWORD) return 'Invalid admin password';
  return null;
}

async function loadWeekGames(season, week) {
  return sql`
    SELECT g.id, g.home_team, g.away_team,
           g.original_home_team, g.original_away_team,
           g.kickoff_at,
           r.home_score AS existing_home, r.away_score AS existing_away,
           r.is_final AS existing_final
    FROM games g
    LEFT JOIN results r ON r.game_id = g.id
    WHERE g.season = ${season} AND g.week = ${week}
    ORDER BY g.kickoff_at NULLS LAST
  `;
}

/** Pull the score for one side out of the provider's scores array. */
function sideScore(entry, fullName, shortName) {
  if (!Array.isArray(entry?.scores)) return null;
  const hit = entry.scores.find(
    (s) => s?.name === fullName || s?.name === shortName
  );
  if (!hit || hit.score === null || hit.score === undefined) return null;
  const n = Number(hit.score);
  return Number.isFinite(n) ? n : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { adminPassword, week: rawWeek, mode = 'preview', scores } = readBody(req);

    const authError = checkAdmin(adminPassword);
    if (authError) return res.status(401).json({ error: authError });

    const weekMissing = rawWeek === undefined || rawWeek === null || rawWeek === '';
    if (weekMissing) return res.status(400).json({ error: 'week required' });
    const week = clampWeek(rawWeek);

    /* ---------------------- apply confirmed scores ---------------------- */
    if (mode === 'apply') {
      if (!Array.isArray(scores) || scores.length === 0) {
        return res.status(400).json({ error: 'scores array required' });
      }
      // Only ids that really belong to this week get written.
      const valid = new Set((await loadWeekGames(SEASON, week)).map((g) => g.id));

      const written = [];
      const skipped = [];
      for (const s of scores) {
        const h = Number(s?.homeScore);
        const a = Number(s?.awayScore);
        if (!valid.has(s?.gameId)) { skipped.push({ gameId: s?.gameId, reason: 'not in this week' }); continue; }
        if (!Number.isFinite(h) || !Number.isFinite(a) || h < 0 || a < 0) {
          skipped.push({ gameId: s.gameId, reason: 'invalid score' });
          continue;
        }
        try {
          await sql`
            INSERT INTO results (game_id, home_score, away_score, is_final)
            VALUES (${s.gameId}, ${h}, ${a}, true)
            ON CONFLICT (game_id) DO UPDATE SET
              home_score = EXCLUDED.home_score,
              away_score = EXCLUDED.away_score,
              is_final   = EXCLUDED.is_final,
              updated_at = CURRENT_TIMESTAMP
          `;
          written.push(s.gameId);
        } catch (e) {
          console.error(`Score write failed for ${s.gameId}:`, e.message);
          skipped.push({ gameId: s.gameId, reason: 'database error' });
        }
      }
      return res.status(200).json({ applied: written.length, written, skipped });
    }

    /* --------------------------- preview -------------------------------- */
    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'Odds API key not configured' });

    const games = await loadWeekGames(SEASON, week);
    if (games.length === 0) {
      return res.status(200).json({ week, proposals: [], note: 'No games stored for this week yet.' });
    }

    // How far back do we need to look? Provider caps this at 3 days.
    const oldest = games
      .map((g) => (g.kickoff_at ? new Date(g.kickoff_at).getTime() : null))
      .filter(Boolean)
      .sort((a, b) => a - b)[0];
    const daysBack = oldest ? Math.ceil((Date.now() - oldest) / 864e5) : 1;
    const daysFrom = Math.min(MAX_DAYS_FROM, Math.max(1, daysBack));
    const beyondWindow = daysBack > MAX_DAYS_FROM;

    const url = new URL(`https://api.the-odds-api.com/v4/sports/${SPORT}/scores/`);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('daysFrom', String(daysFrom));
    url.searchParams.set('dateFormat', 'iso');

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': `SEC-Pickem/${SEASON}` },
    });

    if (!response.ok) {
      // Never echo the upstream URL: it carries ODDS_API_KEY.
      console.error(`Scores API ${response.status}: ${await response.text()}`);
      return res.status(502).json({ error: `Score provider returned ${response.status}` });
    }

    const feed = await response.json();
    const byId = new Map((Array.isArray(feed) ? feed : []).map((e) => [e.id, e]));

    const proposals = games.map((g) => {
      const entry = byId.get(g.id);
      const base = {
        gameId: g.id,
        home: g.home_team,
        away: g.away_team,
        existing: g.existing_final
          ? { homeScore: g.existing_home, awayScore: g.existing_away }
          : null,
      };

      if (!entry) return { ...base, status: 'not_found', homeScore: null, awayScore: null };

      const homeScore = sideScore(entry, g.original_home_team, g.home_team);
      const awayScore = sideScore(entry, g.original_away_team, g.away_team);

      // The important guard. Live games carry partial scores; writing one as
      // final would lock picks and post wrong W/L mid-game.
      if (entry.completed !== true) {
        return {
          ...base,
          status: homeScore !== null ? 'in_progress' : 'not_started',
          homeScore: null,
          awayScore: null,
        };
      }
      if (homeScore === null || awayScore === null) {
        return { ...base, status: 'no_scores', homeScore: null, awayScore: null };
      }

      let status = 'ready';
      if (g.existing_final) {
        status =
          Number(g.existing_home) === homeScore && Number(g.existing_away) === awayScore
            ? 'unchanged'
            : 'differs';
      }
      return { ...base, status, homeScore, awayScore };
    });

    return res.status(200).json({
      week,
      season: SEASON,
      daysFrom,
      beyondWindow,
      // Surfaced so quota use is visible rather than a surprise.
      quotaRemaining: response.headers.get('x-requests-remaining'),
      quotaUsedByCall: response.headers.get('x-requests-last'),
      proposals,
      summary: {
        ready: proposals.filter((p) => p.status === 'ready').length,
        differs: proposals.filter((p) => p.status === 'differs').length,
        unchanged: proposals.filter((p) => p.status === 'unchanged').length,
        pending: proposals.filter((p) =>
          ['in_progress', 'not_started', 'no_scores', 'not_found'].includes(p.status)
        ).length,
      },
    });
  } catch (error) {
    console.error('Scores sync error:', error);
    return res.status(500).json({ error: 'Score sync failed' });
  }
}
