// Static checks for the seed script.
//
// The seed is plain SQL that can only be fully validated by a live PostgreSQL
// server, which the test suite deliberately does not depend on. These checks
// catch the mistakes that are most likely when a script is edited by hand:
// a missing `INSERT INTO` target, an `INSERT ... SELECT ... ON CONFLICT`
// without a WHERE clause (ambiguous in PostgreSQL), and a `demo_key` that is
// not protected by a unique index.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const seedSql = fs.readFileSync(path.join(root, '..', 'db', '002_seed.sql'), 'utf8');
const schemaSql = fs.readFileSync(path.join(root, '..', 'db', '001_schema.sql'), 'utf8');

/** Split a SQL script into statements, ignoring comments and quoted text. */
function splitStatements(sql) {
  const statements = [];
  let depth = 0;
  let current = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (inLineComment) {
      if (character === '\n') inLineComment = false;
      current += character;
      continue;
    }
    if (inBlockComment) {
      current += character;
      if (character === '*' && next === '/') { inBlockComment = false; current += next; index += 1; }
      continue;
    }
    if (!inString && character === '-' && next === '-') { inLineComment = true; current += character; continue; }
    if (!inString && character === '/' && next === '*') { inBlockComment = true; current += character; continue; }
    if (character === "'" && sql[index - 1] !== '\\') inString = !inString;
    if (!inString) {
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
    }
    current += character;
    if (character === ';' && !inString && depth === 0) {
      statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());
  // Drop comment-only statements.
  return statements.map((statement) => statement.replace(/^--[^\n]*$/gm, '').trim()).filter(Boolean);
}

const statements = splitStatements(seedSql);

test('the seed script splits into the expected statements', () => {
  assert.ok(statements.length >= 9, `expected at least 9 statements, found ${statements.length}`);
});

test('every insert statement declares its target table', () => {
  const inserts = statements.filter((statement) => /^(WITH|SELECT)\b/i.test(statement) || /^INSERT\b/i.test(statement));
  for (const statement of inserts) {
    assert.match(
      statement,
      /^INSERT\s+INTO\s+[a-z_]+/i,
      `statement does not start with "INSERT INTO <table>": ${statement.slice(0, 90)}`
    );
  }
});

test('every insert into a table with a demo key protects against conflicts', () => {
  for (const statement of statements.filter((entry) => /^INSERT\s+INTO\s+(orders|order_items|reviews)\b/i.test(entry))) {
    assert.match(statement, /ON\s+CONFLICT\s*\(\s*demo_key\s*\)\s*DO\s+NOTHING/i,
      `seeded rows must use ON CONFLICT (demo_key) DO NOTHING: ${statement.slice(0, 90)}`);
  }
});

test('insert statements that use ON CONFLICT after a select include a where clause', () => {
  // PostgreSQL cannot tell whether a trailing ON belongs to the select or to
  // an ON CONFLICT clause unless the select has a where clause.
  for (const statement of statements.filter((entry) => /ON\s+CONFLICT/i.test(entry) && /SELECT/i.test(entry))) {
    const selectIndex = statement.search(/\bSELECT\b/i);
    const onConflictIndex = statement.search(/\bON\s+CONFLICT\b/i);
    const whereIndex = statement.search(/\bWHERE\b/i);
    assert.ok(whereIndex > selectIndex && whereIndex < onConflictIndex,
      `the select needs a WHERE clause before ON CONFLICT: ${statement.slice(0, 90)}`);
  }
});

test('the demo key columns and their unique indexes are created', () => {
  for (const table of ['orders', 'order_items', 'reviews']) {
    assert.match(seedSql, new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+demo_key`, 'i'),
      `missing demo_key column for ${table}`);
    assert.match(seedSql, new RegExp(`CREATE\\s+UNIQUE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${table}_demo_key_idx`, 'i'),
      `missing unique index for ${table}`);
  }
});

test('the schema script leaves the demo key columns to the seed script', () => {
  // The seed creates the columns itself so that `npm run db:seed` works on
  // its own against a database that already exists.
  assert.doesNotMatch(schemaSql, /demo_key/i);
});

test('the seed never deletes or truncates existing data', () => {
  assert.doesNotMatch(seedSql, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(seedSql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(seedSql, /\bDROP\s+TABLE\b/i);
});

test('the seed increases the number of seeded records', () => {
  const customers = seedSql.match(/generate_series\(1,\s*(\d+)\)/g) || [];
  assert.ok(customers.length >= 4, 'expected several deterministic generators');
  // The product generator is the largest single table in the seed.
  const productSeries = seedSql.match(/generate_series\(1,(\d+)\)\s+n\s*\nJOIN categories/);
  assert.ok(productSeries, 'expected a product generator');
  assert.ok(Number(productSeries[1]) >= 600, `expected at least 600 products, found ${productSeries[1]}`);
});
