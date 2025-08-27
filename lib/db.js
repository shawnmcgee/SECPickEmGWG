import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

export const sql = neon(process.env.DATABASE_URL);

// Test the connection
export async function testConnection() {
  try {
    const result = await sql`SELECT NOW()`;
    console.log('Database connected successfully:', result);
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}
