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
  if (!name) return '';
  
  // First check for exact SEC team matches (case insensitive)
  for (const t of SEC_TEAMS) {
    if (name.toLowerCase().includes(t.toLowerCase())) return t;
  }
  
  // Handle specific team name variations
  const teamMappings = {
    'Mississippi State': ['Miss State', 'Mississippi St'],
    'Texas A&M': ['Texas A&M', 'TAMU'],
    'Ole Miss': ['Mississippi', 'Miss', 'Ole Miss'],
    'South Carolina': ['S Carolina', 'SC'],
  };
  
  for (const [canonical, variations] of Object.entries(teamMappings)) {
    for (const variation of variations) {
      if (name.toLowerCase().includes(variation.toLowerCase())) {
        return canonical;
      }
    }
  }
  
  // Clean up common mascot names but preserve the core team name
  return name
    .replace(/\b(Crimson Tide|Razorbacks|Tigers|Gators|Bulldogs|Wildcats|Rebels|Volunteers|Longhorns|Aggies|Commodores|Sooners|Gamecocks)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function transformGames(arr) {
  console.log(`Transforming ${arr.length} games from API`);
  
  return arr.map(g => {
    const { date, time } = toETParts(g.commence_time);
    const homeRaw = g.home_team || '';
    const awayRaw = g.away_team || '';
    const home = cleanTeamName(homeRaw);
    const away = cleanTeamName(awayRaw);

    console.log(`Processing: ${awayRaw} @ ${homeRaw} -> ${away} @ ${home}`);

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

    const gameObj = {
      id: g.id || `${away}@${home}_${date}_${time}`,
      home, 
      away, 
      spread, 
      total, 
      date, 
      time,
      originalHomeTeam: homeRaw,
      originalAwayTeam: awayRaw,
      isOverUnder: home === 'South Carolina' || away === 'South Carolina',
      isSecMatchup: SEC_TEAMS.includes(home) && SEC_TEAMS.includes(away)
    };

    console.log(`Game created:`, gameObj);
    return gameObj;
  });
}

export default async function handler(req, res) {
  // Set CORS headers for debugging
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    let week = Number(url.searchParams.get('week'));
    if (!week) week = weekFromDate(new Date());
    week = Math.max(1, Math.min(15, week));
    
    const { start, end } = weekRange(week);
    
    // Format dates for API (ISO format in UTC)
    const commenceTimeFrom = start.toISOString();
    const commenceTimeTo = end.toISOString();
    
    console.log(`=== API Request for Week ${week} ===`);
    console.log(`Date range: ${commenceTimeFrom} to ${commenceTimeTo}`);

    const apiKey = process.env.ODDS_API_KEY;
    if (!apiKey) {
      console.error('ODDS_API_KEY environment variable not set');
      return res.status(500).json({ 
        error: 'API key not configured',
        week, 
        games: []
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
    
    console.log('Full API URL:', apiUrl.toString());

    const response = await fetch(apiUrl.toString(), { 
      method: 'GET',
      headers: {
        'User-Agent': 'SEC-Pickem-2025/1.0',
        'Accept': 'application/json',
      },
    });
    
    console.log(`API Response Status: ${response.status}`);
    console.log(`API Response Headers:`, Object.fromEntries(response.headers.entries()));
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Odds API error ${response.status}: ${errorText}`);
      
      return res.status(500).json({
        error: `Odds API returned ${response.status}: ${errorText}`,
        week,
        games: [],
        source: 'api_error'
      });
    }

    const data = await response.json();
    console.log(`Received ${data.length} total games from API`);
    
    // Log first few games to see what we're getting
    if (data.length > 0) {
      console.log('Sample games from API:');
      data.slice(0, 3).forEach((game, i) => {
        console.log(`  ${i + 1}. ${game.away_team} @ ${game.home_team} (${game.commence_time})`);
      });
    }
    
    // Filter to games involving SEC teams (more lenient matching)
    const secGames = data.filter(g => {
      const homeTeam = (g.home_team || '').toLowerCase();
      const awayTeam = (g.away_team || '').toLowerCase();
      
      const isSecGame = SEC_TEAMS.some(secTeam => 
        homeTeam.includes(secTeam.toLowerCase()) || 
        awayTeam.includes(secTeam.toLowerCase())
      );
      
      if (isSecGame) {
        console.log(`✓ SEC Game found: ${g.away_team} @ ${g.home_team}`);
      }
      
      return isSecGame;
    });
    
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
      } else {
        console.log(`Duplicate removed: ${g.away} @ ${g.home} ${g.date} ${g.time}`);
      }
    }
    
    console.log(`Final game count after deduplication: ${deduped.length}`);
    
    // Sort games by date and time
    deduped.sort((a, b) => {
      const dateCompare = a.date.localeCompare(b.date);
      if (dateCompare !== 0) return dateCompare;
      return a.time.localeCompare(b.time);
    });

    // Log final games
    console.log('Final games being returned:');
    deduped.forEach((game, i) => {
      console.log(`  ${i + 1}. ${game.away} @ ${game.home} (${game.date} ${game.time}) - Spread: ${game.spread}, Total: ${game.total}`);
    });

    const responseData = { 
      week, 
      games: deduped,
      source: 'api',
      count: deduped.length,
      originalCount: data.length,
      secFilteredCount: secGames.length,
      dateRange: {
        from: commenceTimeFrom,
        to: commenceTimeTo
      },
      debug: {
        apiUrl: apiUrl.toString(),
        hasApiKey: !!apiKey,
        responseStatus: response.status
      }
    };

    console.log('=== Final Response ===');
    console.log(`Returning ${responseData.games.length} games`);
    
    return res.status(200).json(responseData);
    
  } catch (error) {
    console.error('=== API Handler Error ===');
    console.error('Error details:', error);
    console.error('Stack trace:', error.stack);
    
    return res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      week: week || 1, 
      games: [],
      source: 'server_error'
    });
  }
}
