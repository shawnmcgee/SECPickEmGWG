export default async function handler(req, res) {
  try {
    // Check if environment variable exists
    const hasDbUrl = !!process.env.DATABASE_URL;
    
    // Try to load the module
    let moduleLoaded = false;
    let sql = null;
    
    try {
      const { neon } = await import('@neondatabase/serverless');
      moduleLoaded = true;
      
      if (hasDbUrl) {
        sql = neon(process.env.DATABASE_URL);
        // Test query
        const result = await sql`SELECT NOW() as time`;
        
        return res.status(200).json({
          success: true,
          hasDbUrl,
          moduleLoaded,
          connected: true,
          time: result[0].time
        });
      }
    } catch (error) {
      return res.status(500).json({
        hasDbUrl,
        moduleLoaded,
        error: error.message
      });
    }
  } catch (error) {
    return res.status(500).json({
      error: 'Critical failure',
      message: error.message
    });
  }
}
