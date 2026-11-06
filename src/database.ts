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

    // `coarse`: geotag s najviac jedným desatinným miestom v oboch súradniciach.
    // Tak sú otagované zábery Zeme z ISS (napr. 40.2, 6.4 — stanica letela
    // nad morom) a iné družicové snímky; dump o nich inak nič nehovorí. Také
    // body sa predvolene nevracajú (`/pictures?iss=1` ich vráti). Stĺpec sa
    // pri prvom pridaní naplní z existujúcich riadkov; import ho ďalej
    // udržiava z reťazca v dumpe (presnejšie než z čísla).
    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name = 'wikimedia_photo' AND column_name = 'coarse'`,
    );
    if (col.rowCount === 0) {
      await client.query(`ALTER TABLE wikimedia_photo ADD COLUMN coarse BOOLEAN NOT NULL DEFAULT false`);
      const res = await client.query(`
        UPDATE wikimedia_photo SET coarse = true
        WHERE abs(ST_X(location) * 10 - round(ST_X(location) * 10)) < 1e-7
          AND abs(ST_Y(location) * 10 - round(ST_Y(location) * 10)) < 1e-7
      `);
      console.log(`Marked ${res.rowCount} photos with coarse (ISS-like) coordinates.`);
    }

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
