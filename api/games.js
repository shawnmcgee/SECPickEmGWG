// /api/games.js
const SEC_TEAMS_FULL = [
  "Alabama Crimson Tide",
  "Arkansas Razorbacks", // Best guess following naming pattern
  "Auburn Tigers",
  "Florida Gators", // Best guess following naming pattern
  "Georgia Bulldogs",
  "Kentucky Wildcats",
  "LSU Tigers",
  "Ole Miss Rebels",
  "Mississippi State Bulldogs",
  "Missouri Tigers",
  "Oklahoma Sooners",
  "South Carolina Gamecocks",
  "Tennessee Volunteers",
  "Texas Longhorns",
  "Texas A&M Aggies",
  "Vanderbilt Commodores"
];

// Map full names to short names for display
const TEAM_NAME_MAP = {
  "Alabama Crimson Tide": "Alabama",
  "Arkansas Razorbacks": "Arkansas",
  "Auburn Tigers": "Auburn",
  "Florida Gators": "Florida",
  "Georgia Bulldogs": "Georgia",
  "Kentucky Wildcats": "Kentucky",
  "LSU Tigers": "LSU",
  "Ole Miss Rebels": "Ole Miss",
  "Mississippi State Bulldogs": "Mississippi State",
  "Missouri Tigers": "Missouri",
  "Oklahoma Sooners": "Oklahoma",
  "South Carolina Gamecocks": "South Carolina",
  "Tennessee Volunteers": "Tennessee",
  "Texas Longhorns": "Texas",
  "Texas A&M Aggies": "Texas A&M",
  "Vanderbilt Commodores": "Vanderbilt"
};

// Short names for backward compatibility
const SEC_TEAMS_SHORT = Object.values(TEAM_NAME_MAP);

// 2025 Season starts Thursday, August 28th
const SEASON_START = new Date("2025-08-28T00:00:00-04:00"); // ET

function weekFromDate(d) {
  const ms = d - SEASON_START;
  if (ms < 0) return 1;
  const week = Math.floor(ms / (7*24*60*60*1000)) + 1;
  return Math.max(1, Math.min(15, week));
}

function weekRange(week) {
  // Week 1: Thu Aug 28 - Sun Aug 31 (special case - 4 days)
  // Other weeks: Thursday to following Wednesday (7 days)
  
  if (week === 1) {
    // Special case for Week 1 - shorter week
    const start = new Date("2025-08-28T00:00:00-04:00");
    const end = new Date("2025-08-31T23:59:59-04:00");
    return { start, end };
  }
  
  // Regular weeks start on Thursday
  // Week 2 starts Sep 4, Week 3 starts Sep 11, etc.
  const weekOffset = week - 2; // Since we're calculating from Week 2
  const baseDate = new Date("2025-09-04T00:00:00-04:00"); // Week 2 start
  
  const start = new Date(baseDate.getTime() + (weekOffset * 7 * 24 * 60 * 60 * 1000));
  const end = new Date(start.getTime() + (6 * 24 * 60 * 60 * 1000) + (23 * 60 * 60 * 1000) + (59 * 60 * 1000) + (59 * 1000)); // Through following Wednesday
  
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

function formatDateForAPI(date) {
  // Format date to YYYY-MM-DDTHH:MM:SSZ format required by API
  // Set to start of day (00:00:00) in UTC
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}T00:00:00Z`;
}

function formatEndDateForAPI(date) {
  // Format end date to YYYY-MM-DDTHH:MM:SSZ format required by API
  // Set to end of day (23:59:59) in UTC
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}T23:59:59Z`;
}

function isSecTeam(teamName) {
  if (!teamName) return false;
  
  // Check for exact match with full SEC team names
  return SEC_TEAMS_FULL.some(secTeam => 
    teamName.toLowerCase() === secTeam.toLowerCase()
  );
}

function getShortTeamName(fullTeamName) {
  if (!fullTeamName) return '';
  
  // Return the mapped short name, or the original if not found
  return TEAM_NAME_MAP[fullTeamName] || fullTeamName;
}

function transformGames(arr) {
  console.log(`Transforming ${arr.length} games from API`);
  
  return arr.map(g => {
    const { date, time } = toETParts(g.commence_time);
    const homeRaw = g.home_team || '';
    const awayRaw = g.away_team || '';
    
    // Get short display names
    const home = getShortTeamName(homeRaw);
    const away = getShortTeamName(awayRaw);

    console.log(`Processing: ${awayRaw} @ ${homeRaw} -> ${away} @ ${home}`);

    let spread = 0, total = 50;
    
    // Use the first available bookmaker (DraftKings)
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

    // Skip games without betting lines (like Florida vs LIU)
    if (spread === 0 && total === 50) {
      console.log(`Skipping game with no betting lines: ${away} @ ${home}`);
      return null;
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
      isSecMatchup: SEC_TEAMS_SHORT.includes(home) && SEC_TEAMS_SHORT.includes(away)
    };

    console.log(`Game created:`, gameObj);
    return gameObj;
  }).filter(game => game !== null); // Remove games with no betting lines
}

export default async function handler(req, res) {
  // Set CORS headers for debugging
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let week = 1; // Initialize week variable

  try {
    const url = new URL(req.url, 'http://localhost');
    week = Number(url.searchParams.get('week'));
    if (!week) week = weekFromDate(new Date());
    week = Math.max(1, Math.min(15, week));
    
    const { start, end } = weekRange(week);
    
    // Format dates for API using the correct format: YYYY-MM-DDTHH:MM:SSZ
    const commenceTimeFrom = formatDateForAPI(start);
    const commenceTimeTo = formatEndDateForAPI(end);
    
    console.log(`=== API Request for Week ${week} ===`);
    console.log(`Date range: ${commenceTimeFrom} to ${commenceTimeTo}`);
    console.log('SEC teams we\'re looking for:', SEC_TEAMS_FULL);

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
    apiUrl.searchParams.set('bookmakers', 'draftkings');
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
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Odds API error ${response.status}: ${errorText}`);
      
      return res.status(500).json({
        error: `Odds API returned ${response.status}: ${errorText}`,
        week,
        games: [],
        source: 'api_error',
        debug: {
          commenceTimeFrom,
          commenceTimeTo,
          apiUrl: apiUrl.toString(),
          responseStatus: response.status
        }
      });
    }

    const data = await response.json();
    console.log(`Received ${data.length} total games from API`);
    
    // Log all team names we're getting from the API for debugging
    console.log('All team names from API:');
    const allTeams = new Set();
    data.forEach(game => {
      allTeams.add(game.home_team);
      allTeams.add(game.away_team);
    });
    Array.from(allTeams).sort().forEach(team => console.log(`  "${team}"`));
    
    // Filter to games involving SEC teams using exact name matching
    const secGames = data.filter(g => {
      const homeTeam = g.home_team || '';
      const awayTeam = g.away_team || '';
      
      const homeIsSec = isSecTeam(homeTeam);
      const awayIsSec = isSecTeam(awayTeam);
      const isSecGame = homeIsSec || awayIsSec;
      
      if (isSecGame) {
        console.log(`✓ SEC Game found: ${g.away_team} @ ${g.home_team} (Home SEC: ${homeIsSec}, Away SEC: ${awayIsSec})`);
      } else {
        // Log some non-SEC games to see what we're filtering out
        if (homeTeam.toLowerCase().includes('florida') || awayTeam.toLowerCase().includes('florida')) {
          console.log(`✗ Non-SEC Florida game filtered: ${g.away_team} @ ${g.home_team}`);
        }
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
        responseStatus: response.status,
        secTeamsLookedFor: SEC_TEAMS_FULL,
        allTeamsFound: Array.from(allTeams).sort()
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
