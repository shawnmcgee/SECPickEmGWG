let sql;

try {
  const { neon } = require('@neondatabase/serverless');
  
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL environment variable is not set');
    sql = null;
  } else {
    sql = neon(process.env.DATABASE_URL);
  }
} catch (error) {
  console.error('Failed to load @neondatabase/serverless:', error);
  sql = null;
}

export { sql };
