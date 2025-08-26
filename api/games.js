// /api/games.js
const SEC_TEAMS = [
  "Alabama","Arkansas","Auburn","Florida","Georgia","Kentucky","LSU","Ole Miss",
  "Mississippi State","Missouri","Oklahoma","South Carolina","Tennessee","Texas",
  "Texas A&M","Vanderbilt"
];

// 2025 Season starts Thursday, August 28th
const SEASON_START = new Date("2025-08-28T00:00:00-04:00"); // ET

function weekFromDate(d) {
  const ms = d - SEASON_START;
  if (ms < 0) return 1;
  const week = Math.floor(ms / (7*24*60*60*1000)) + 1;
  return Math.max(1, Math.min(15, week));
}

function weekRange(week) {
  // Each week runs Thursday to Tuesday (6 days)
  // Week 1: Thu Aug 28 - Tue Sep 2
  // Week 2: Thu Sep 4 - Tue Sep 9, etc.
  const start = new Date(SEASON_START.getTime() + (week-1)*7*24*60*60*1000);
  const end = new Date(start.getTime() + 5*24*60*60*1000); // Thursday + 5 days = Tuesday
  
  return { start, end };
}

function toETParts(iso) {
  // returns {date: 'YYYY-MM-DD', time: 'HH:MM'} in America/New_York
  const opts = { 
    timeZone: 'America/New_York', 
    hour12: false,
    year: 'numeric', 
    month: '2-digit', 
    day: '2-digit',
    hour: '2-digit', 
    minute: '2-digit' 
  };
  const fmt = new Intl.DateTimeFormat('en-CA', opts).formatToParts(new Date(iso));
  const get = t => fmt.find(p => p.type === t)?.value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const time = `${get('hour')}:${get('minute')}`;
  return { date, time };
}

function cleanTeamName(name) {
  // First check for exact SEC team matches
  for (const t of SEC_TEAMS) {
    if (name.includes(t)) return t;
  }
  
  // Clean up common team name variations
  return name
    .replace(/Crimson Tide|Razorbacks|Tigers|Gators|Bulldogs|Wildcats|Rebels|Volunteers|Longhorns|Aggies|Commodores|Sooners|Gamecocks/gi, '')
    .replace(/State$/, 'State') // Keep "State" for Mississippi State
    .replace(/^Miss\s/, 'Mississippi ') // Convert "Miss State" to "Mississippi State"
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
    
    // Use the first available bookmaker (we'll filter to DraftKings in the API call)
    const bm = (g.bookmakers||[])[0];
    if (bm && bm.markets) {
      const sp = bm.markets.find(m => m.key === 'spreads');
      const to = bm.markets.find(m => m.key === 'totals');
      
      if (sp?.outcomes) {
        const homeOutcome = sp.outcomes.find(o => o.name === homeRaw);
        if (homeOutcome?.point !== undefined) {
          spread = Number(homeOutcome.point);
        }
      }
      
      if (to?.outcomes?.[0]?.point !== undefined) {
        total = Number(to.outcomes[0].point);
      }
    }

    return {
      id: g.id || `${away}@${home}_${date}_${time}`,
      home, 
      away, 
      spread, 
      total, 
      date, 
      time,
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
    
    // Format dates for API (ISO format in UTC)
    const commenceTimeFrom = start.toISOString();
    const commenceTimeTo = end.toISOString();
    
    console.log(`Fetching games for Week ${week}: ${commenceTimeFrom} to ${commenceTimeTo}`);

    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
      console.error('ODDS_API_KEY environment variable not set');
      return res.status(200).json({ 
        week, 
        games: [], 
        error: 'API key not configured' 
      });
    }
    
    // Build API URL with proper parameters
    const apiUrl = new URL('https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds/');
    apiUrl.searchParams.set('apiKey', apiKey);
    apiUrl.searchParams.set('regions', 'us');
    apiUrl.searchParams.set('markets', 'spreads,totals');
    apiUrl.searchParams.set('oddsFormat', 'american');
    apiUrl.searchParams.set('dateFormat', 'iso');
    apiUrl.searchParams.set('bookmakers', 'draftkings'); // Single bookmaker for consistency
    apiUrl.searchParams.set('commenceTimeFrom', commenceTimeFrom);
    apiUrl.searchParams.set('commenceTimeTo', commenceTimeTo);
    
    console.log('API URL:', apiUrl.toString());

    const response = await fetch(apiUrl.toString(), { 
      timeout: 30000,
      headers: {
        'User-Agent': 'SEC-Pickem-2025/1.0'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Odds API error ${response.status}: ${errorText}`);
      
      // Return fallback data for Week 1 if API fails
      if (week === 1) {
        return res.status(200).json({ 
          week, 
          games: getWeek1Fallback(),
          source: 'fallback'
        });
      }
      
      throw new Error(`Odds API ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    console.log(`Received ${data.length} total games from API`);
    
    // Filter to games involving SEC teams
    const secGames = data.filter(g => 
      SEC_TEAMS.some(t => 
        (g.home_team || '').includes(t) || 
        (g.away_team || '').includes(t)
      )
    );
    
    console.log(`Filtered to ${secGames.length} SEC-related games`);
    
    // Transform and deduplicate games
    const transformedGames = transformGames(secGames);
    
    // Remove duplicates based on teams and kickoff time
    const seen = new Set();
    const deduped = [];
    
    for (const g of transformedGames) {
      const key = `${g.home}|${g.away}|${g.date}|${g.time}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(g);
      }
    }
    
    console.log(`Final game count after deduplication: ${deduped.length}`);
    
    // Sort games by date and time
    deduped.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.time.localeCompare(b.time);
    });

    res.status(200).json({ 
      week, 
      games: deduped,
      source: 'api',
      count: deduped.length,
      dateRange: {
        from: commenceTimeFrom,
        to: commenceTimeTo
      }
    });
    
  } catch (error) {
    console.error('API handler error:', error);
    
    // Return fallback data for Week 1
    if (week === 1) {
      res.status(200).json({ 
        week: 1, 
        games: getWeek1Fallback(),
        source: 'fallback',
        error: error.message
      });
    } else {
      res.status(200).json({ 
        week: week || 1, 
        games: [],
        source: 'error',
        error: error.message
      });
    }
  }
}
}
