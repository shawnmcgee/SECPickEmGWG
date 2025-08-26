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

// Fallback data for Week 1 2025
function getWeek1Fallback() {
  return [
    {
      id: 'week1_texas_ohiostate',
      away: 'Texas',
      home: 'Ohio State',
      date: '2025-08-30',
      time: '12:00',
      spread: 3.5, // Ohio State favored
      total: 52.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_auburn_baylor',
      away: 'Auburn',
      home: 'Baylor',
      date: '2025-08-29',
      time: '20:00',
      spread: -2.5, // Auburn favored
      total: 55.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_southcarolina_virginiatech',
      away: 'South Carolina',
      home: 'Virginia Tech',
      date: '2025-08-31',
      time: '15:00',
      spread: 1.5, // VT slight favorite
      total: 48.5,
      isOverUnder: true, // South Carolina game = O/U
      isSecMatchup: false
    },
    {
      id: 'week1_alabama_floridastate',
      away: 'Alabama',
      home: 'Florida State',
      date: '2025-08-30',
      time: '15:30',
      spread: -10.5, // Alabama big favorite
      total: 59.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_marshall_georgia',
      away: 'Marshall',
      home: 'Georgia',
      date: '2025-08-30',
      time: '15:30',
      spread: 28.5, // Georgia huge favorite
      total: 61.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_utsa_texasam',
      away: 'UTSA',
      home: 'Texas A&M',
      date: '2025-08-30',
      time: '19:00',
      spread: 21.5, // A&M big favorite
      total: 54.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_charleston_vanderbilt',
      away: 'Charleston Southern',
      home: 'Vanderbilt',
      date: '2025-08-30',
      time: '19:00',
      spread: 35.5, // Vandy huge favorite
      total: 58.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_toledo_kentucky',
      away: 'Toledo',
      home: 'Kentucky',
      date: '2025-08-30',
      time: '12:45',
      spread: 14.5, // UK favorite
      total: 52.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_centralarks_missouri',
      away: 'Central Arkansas',
      home: 'Missouri',
      date: '2025-08-28',
      time: '19:30',
      spread: 24.5, // Mizzou big favorite
      total: 56.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_georgiastate_olemiss',
      away: 'Georgia State',
      home: 'Ole Miss',
      date: '2025-08-30',
      time: '19:45',
      spread: 28.5, // Ole Miss big favorite
      total: 63.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_msstate_southernmiss',
      away: 'Mississippi State',
      home: 'Southern Miss',
      date: '2025-08-30',
      time: '12:00',
      spread: -7.5, // MSU favorite on road
      total: 49.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_alabamaam_arkansas',
      away: 'Alabama A&M',
      home: 'Arkansas',
      date: '2025-08-30',
      time: '15:15',
      spread: 42.5, // Arkansas huge favorite
      total: 64.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_liu_florida',
      away: 'LIU',
      home: 'Florida',
      date: '2025-08-30',
      time: '19:00',
      spread: 48.5, // Florida massive favorite
      total: 67.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_illinoisstate_oklahoma',
      away: 'Illinois State',
      home: 'Oklahoma',
      date: '2025-08-30',
      time: '18:00',
      spread: 35.5, // OU big favorite
      total: 61.5,
      isOverUnder: false,
      isSecMatchup: false
    },
    {
      id: 'week1_syracuse_tennessee',
      away: 'Syracuse',
      home: 'Tennessee',
      date: '2025-08-30',
      time: '12:00',
      spread: 17.5, // Tennessee favorite
      total: 56.5,
      isOverUnder: false,
      isSecMatchup: false
    }
  ];
}
