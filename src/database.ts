/**
 * WikiMediaCache Microservice for Freemap
 * Open-source project for caching Wikimedia Commons thumbnails.
 * Author: Ladislav Nagy
 */

import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'freemap',
  password: process.env.DB_PASSWORD || 'freemap',
  database: process.env.DB_NAME || 'freemap',
});

export async function initDb() {
  const client = await pool.connect();
  try {
    // Create the wikimedia_photo table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS wikimedia_photo (
        page_id     INTEGER PRIMARY KEY,
        location    GEOMETRY(Point, 4326) NOT NULL,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create GiST spatial index for fast bounding box queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS wikimedia_location_spx 
      ON wikimedia_photo USING GIST (location)
    `);

    console.log('Database schema initialized.');
  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  } finally {
    client.release();
  }
}

export function getPool() {
  return pool;
}
