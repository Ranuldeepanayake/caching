// Structural checks for the SQL files.
//
// These checks catch unbalanced parentheses, stray unterminated strings, and
// statements that are cut off mid-way. They are a static safety net for the
// seed and schema scripts; a live PostgreSQL server is still the authority on
// whether the SQL executes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = fs.readFileSync(path.join(root, '..', 'db', '001_schema.sql'), 'utf8');
const seedSql = fs.readFileSync(path.join(root, '..', 'db', '002_seed.sql'), 'utf8');

/** Scan SQL and report the parenthesis depth at each statement boundary. */
function analyze(sql) {
  let depth = 0;
  let statements = 0;
  let inString = false;
  let quoteCount = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    if (character === "'" && sql[index - 1] !== '\\') {
      inString = !inString;
      quoteCount += 1;
      continue;
    }
    if (inString) continue;
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ';') {
      statements += 1;
      assert.equal(depth, 0, `statement ${statements} ends with an unbalanced parenthesis depth of ${depth}`);
    }
  }
  assert.equal(depth, 0, `the script ends with an unbalanced parenthesis depth of ${depth}`);
  assert.equal(inString, false, 'the script contains an unterminated string literal');
  assert.equal(quoteCount % 2, 0, 'the script contains an odd number of quote characters');
  return statements;
}

test('the schema script is structurally balanced', () => {
  const statements = analyze(schemaSql);
  assert.ok(statements >= 7, `expected at least 7 statements, found ${statements}`);
});

test('the seed script is structurally balanced', () => {
  const statements = analyze(seedSql);
  assert.ok(statements >= 9, `expected at least 9 statements, found ${statements}`);
});

test('the seed script references only tables that the schema creates', () => {
  // Comments are stripped first: prose such as "derived from a deterministic
  // generator" would otherwise look like a reference to a table named "a".
  const code = seedSql.replace(/--[^\n]*/g, '');
  // Common table expressions are local aliases, not schema tables. A CTE may
  // declare a column list and may be chained after a comma, so the alias is
  // matched wherever an "AS (" definition appears.
  const cteNames = new Set([...code.matchAll(/([a-z_]+)\s*(?:\([^)]*\))?\s*AS\s*\(/gi)].map((match) => match[1]));
  const created = [...schemaSql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-z_]+)/gi)].map((match) => match[1]);
  const referenced = [...code.matchAll(/(?:INSERT\s+INTO|ALTER\s+TABLE)\s+([a-z_]+)/gi)].map((match) => match[1]);
  // Table references in FROM and JOIN clauses, excluding CTE aliases.
  for (const match of code.matchAll(/(?:FROM|JOIN)\s+([a-z_]+)/gi)) {
    const name = match[1];
    if (name === 'generate_series' || cteNames.has(name)) continue;
    referenced.push(name);
  }
  const known = new Set([...created]);
  for (const table of new Set(referenced)) {
    assert.ok(known.has(table), `the seed references unknown table "${table}"`);
  }
});

test('the seed script does not reference a column that the schema does not create', () => {
  // The demo_key columns are the only columns the seed adds itself.
  const seedCreated = new Set(['demo_key']);
  const explicitColumns = {
    customers: ['email', 'full_name'],
    products: ['category_id', 'sku', 'name', 'description', 'price'],
    inventory: ['product_id', 'warehouse', 'available_quantity', 'reserved_quantity'],
    orders: ['customer_id', 'status', 'ordered_at'],
    order_items: ['order_id', 'product_id', 'quantity', 'unit_price'],
    reviews: ['customer_id', 'product_id', 'rating', 'review_text', 'is_approved'],
    categories: ['name', 'slug']
  };
  for (const [table, columns] of Object.entries(explicitColumns)) {
    const pattern = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]+)\\)`, 'i');
    const match = seedSql.match(pattern);
    assert.ok(match, `expected an INSERT INTO ${table} with an explicit column list`);
    for (const column of match[1].split(',').map((value) => value.trim())) {
      assert.ok(columns.includes(column) || seedCreated.has(column),
        `column "${column}" is not created for table "${table}"`);
    }
  }
});
