// /api/standings.js
import { sql } from '../lib/db';

function calculateSpreadWinner(spread, homeScore, awayScore, homeTeam, awayTeam, userSelection) {
  const margin = homeScore - awayScore;
  
  if (userSelection === homeTeam) {
    // User picked home team, they win if home covers the spread
    return margin > Math.abs(spread);
  } else {
    // User picked away team, they win if away covers the spread  
    return margin < -Math.abs(spread);
  }
}

function calculateTotalResult(total, homeScore, awayScore, userSelection) {
  const totalPoints = homeScore + awayScore;
  
  if (userSelection === 'over') {
    return totalPoints > total;
  } else if (userSelection === 'under') {
    return totalPoints < total;
  }
  
  return false; // Push
}

function isPush(pickType, spread, total, homeScore, awayScore) {
  if (pickType === 'spread') {
    return Math.abs(homeScore - awayScore) === Math.abs(spread);
  } else {
    return (homeScore + awayScore) === total;
  }
}

export default async function handler(req, res) {
  try {
    const { week, season } = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    
    if (req.method === 'GET') {
      if (season === 'true') {
        // Get season standings
        console.log('Fetching season standings');
        
        const standings = await sql`
          SELECT 
            u.name,
            COUNT(CASE 
              WHEN r.is_final = true AND (
                (p.pick_type = 'spread' AND 
                 ((p.selection = g.home_team AND (r.home_score - r.away_score) > (-p.line)) OR
                  (p.selection = g.away_team AND (r.away_score - r.home_score) > p.line))) OR
                (p.pick_type = 'total' AND
                 ((p.selection = 'over' AND (r.home_score + r.away_score) > p.line) OR
                  (p.selection = 'under' AND (r.home_score + r.away_score) < p.line)))
              )
              THEN 1 
            END) as wins,
            COUNT(CASE 
              WHEN r.is_final = true AND (
                (p.pick_type = 'spread' AND 
                 ((p.selection = g.home_team AND (r.home_score - r.away_score) = (-p.line)) OR
                  (p.selection = g.away_team AND (r.away_score - r.home_score) = p.line))) OR
                (p.pick_type = 'total' AND (r.home_score + r.away_score) = p.line)
              )
              THEN 1 
            END) as pushes,
            COUNT(CASE 
              WHEN r.is_final = true
              THEN 1
            END) -
            COUNT(CASE 
              WHEN r.is_final = true AND (
                (p.pick_type = 'spread' AND 
                 ((p.selection = g.home_team AND (r.home_score - r.away_score) > (-p.line)) OR
                  (p.selection = g.away_team AND (r.away_score - r.home_score) > p.line))) OR
                (p.pick_type = 'total' AND
                 ((p.selection = 'over' AND (r.home_score + r.away_score) > p.line) OR
                  (p.selection = 'under' AND (r.home_score + r.away_score) < p.line)))
              )
              THEN 1 
            END) -
            COUNT(CASE 
              WHEN r.is_final = true AND (
                (p.pick_type = 'spread' AND 
                 ((p.selection = g.home_team AND (r.home_score - r.away_score) = (-p.line)) OR
                  (p.selection = g.away_team AND (r.away_score - r.home_score) = p.line))) OR
                (p.pick_type = 'total' AND (r.home_score + r.away_score) = p.line)
              )
              THEN 1 
            END) as losses
          FROM users u
          LEFT JOIN picks p ON u.id = p.user_id
          LEFT JOIN games g ON p.game_id = g.id
          LEFT JOIN results r ON g.id = r.game_id
          GROUP BY u.name
          HAVING COUNT(p.id) > 0
          ORDER BY wins DESC, pushes DESC, losses ASC
        `;

        console.log(`Found season standings for ${standings.length} users`);
        
        return res.status(200).json({
          standings: standings.map(s => {
            const wins = parseInt(s.wins) || 0;
            const losses = parseInt(s.losses) || 0;
            const pushes = parseInt(s.pushes) || 0;
            const totalGames = wins + losses;
            const winPercentage = totalGames > 0 ? Math.round((wins / totalGames) * 100) : 0;
            
            return {
              name: s.name,
              wins,
              losses,
              pushes,
              winPercentage
            };
          }),
          scope: 'season',
          week: null
        });
        
      } else if (week) {
        // Get weekly standings
        console.log(`Fetching weekly standings for week ${week}`);
        
        const standings = await sql`
          SELECT 
            u.name,
            COUNT(CASE 
              WHEN r.is_final = true AND (
                (p.pick_type = 'spread' AND 
                 ((p.selection = g.home_team AND (r.home_score - r.away_score) > (-p.line)) OR
                  (p.selection = g.away_team AND (r.away_score - r.home_score) > p.line))) OR
                (p.pick_type = 'total' AND
                 ((p.selection = 'over' AND (r.home_score + r.away_score) > p.line) OR
                  (p.selection = 'under' AND (r.home_score + r.away_score) < p.line)))
              )
              THEN 1 
            END) as wins,
            COUNT(CASE 
              WHEN r.is_final = true AND (
                (p.pick_type = 'spread' AND 
                 ((p.selection = g.home_team AND (r.home_score - r.away_score) = (-p.line)) OR
                  (p.selection = g.away_team AND (r.away_score - r.home_score) = p.line))) OR
                (p.pick_type = 'total' AND (r.home_score + r.away_score) = p.line)
              )
              THEN 1 
            END) as pushes,
            COUNT(p.id) as total_picks,
            COUNT(CASE WHEN r.is_final = true THEN 1 END) as completed_picks
          FROM users u
          LEFT JOIN picks p ON u.id = p.user_id
          LEFT JOIN games g ON p.game_id = g.id AND g.week = ${Number(week)}
          LEFT JOIN results r ON g.id = r.game_id
          GROUP BY u.name
          HAVING COUNT(p.id) > 0
          ORDER BY wins DESC, total_picks DESC
        `;

        console.log(`Found weekly standings for ${standings.length} users`);

        const formattedStandings = standings.map(s => {
          const wins = parseInt(s.wins) || 0;
          const pushes = parseInt(s.pushes) || 0;
          const totalPicks = parseInt(s.total_picks) || 0;
          const completedPicks = parseInt(s.completed_picks) || 0;
          const losses = completedPicks - wins - pushes;
          
          return {
            name: s.name,
            wins,
            losses: Math.max(0, losses),
            pushes,
            totalPicks,
            completedPicks,
            record: `${wins}-${Math.max(0, losses)}${pushes > 0 ? `-${pushes}` : ''}`
          };
        });
        
        return res.status(200).json({
          standings: formattedStandings,
          scope: 'week',
          week: Number(week)
        });
        
      } else {
        // Get all users with pick counts (for current state)
        const users = await sql`
          SELECT 
            u.name,
            COUNT(p.id) as total_picks
          FROM users u
          LEFT JOIN picks p ON u.id = p.user_id
          GROUP BY u.name
          ORDER BY total_picks DESC
        `;

        return res.status(200).json({
          standings: users.map(u => ({
            name: u.name,
            totalPicks: parseInt(u.total_picks) || 0
          })),
          scope: 'users'
        });
      }
    }

    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Standings API error:', error);
    return res.status(500).json({ 
      error: 'Server error', 
      detail: error.message 
    });
  }
}
