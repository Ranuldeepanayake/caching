// Apply only the repeatable demo dataset. This is useful when the schema already
// exists and a developer wants to refresh a local demo without running migrations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertConfig } from '../src/config.js';
import { createPostgresPool } from '../src/providers/postgres.js';

assertConfig();
const root = path.dirname(fileURLToPath(import.meta.url));
const pool = await createPostgresPool();

try {
  const seedFile = path.join(root, '..', 'db', '002_seed.sql');
  console.log(`${new Date().toISOString()} [seed] applying ${seedFile}`);
  await pool.query(await fs.readFile(seedFile, 'utf8'));
  console.log(`${new Date().toISOString()} [seed] completed successfully`);
} finally {
  await pool.end();
}
