// Apply the schema and deterministic demo seed in order. This is a bootstrap
// helper, not a replacement for a versioned production migration system.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig } from '../src/config.js';
import { createPostgresPool } from '../src/providers/postgres.js';
assertConfig();
const root = path.dirname(fileURLToPath(import.meta.url));
// Reuse the production provider adapter so AWS endpoint discovery and retries also work for migrations.
const pool = await createPostgresPool();
// The SQL files are applied in dependency order: tables/indexes first, then data.
for (const file of ['001_schema.sql', '002_seed.sql']) { console.log(`${new Date().toISOString()} [migrate] applying ${file}`); await pool.query(await fs.readFile(path.join(root, '..', 'db', file), 'utf8')); }
// Release the pool so the one-shot process exits cleanly.
await pool.end();
