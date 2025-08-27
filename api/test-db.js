import { sql, testConnection } from '../lib/db';

export default async function handler(req, res) {
  try {
    // Test basic connection
    const connected = await testConnection();
    
    if (!connected) {
      return res.status(500).json({ 
        error: 'Database connection failed',
        hasUrl: !!process.env.DATABASE_URL 
      });
    }
    
    // Test tables exist
    const tables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
    `;
    
    return res.status(200).json({ 
      success: true, 
      tables: tables.map(t => t.table_name),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Database test error:', error);
    return res.status(500).json({ 
      error: error.message,
      stack: error.stack,
      hasUrl: !!process.env.DATABASE_URL
    });
  }
}
