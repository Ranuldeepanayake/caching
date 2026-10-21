// Invalidation service tests cover the automatic change detection, the manual
// invalidation path, and the rule that a failed check must not clear the cache.
//
// The connection retry settings are lowered before the modules are imported, so
// a failing database query returns quickly instead of waiting out the
// production backoff.
process.env.CONNECTION_RETRY_ATTEMPTS = '1';
process.env.CONNECTION_RETRY_BASE_DELAY_MS = '1';

import test from 'node:test';
import assert from 'node:assert/strict';
const { createInvalidationService } = await import('../src/services/invalidationService.js');

// The fingerprint repository reads raw database columns, so the fake pool must
// return the same column shape that the SQL query produces.
const rawRow = (products) => ({
  categories: 3,
  products,
  inventory: products,
  orders: 8,
  order_items: 24,
  reviews: 180,
  categories_hash: 'categories-hash',
  products_hash: `products-hash-${products}`,
  inventory_hash: 'inventory-hash',
  orders_hash: 'orders-hash',
  order_items_hash: 'order-items-hash',
  reviews_hash: 'reviews-hash'
});

const makeService = ({ current, onInvalidate }) => {
  const pool = { query: async () => ({ rows: [current] }) };
  const redis = { get: async () => null, incr: async () => 1 };
  const productService = { invalidate: async () => { onInvalidate?.(); return { generation: 1, persisted: true }; } };
  return createInvalidationService(pool, redis, productService);
};

test('establishes a baseline on the first check without invalidating', async () => {
  let invalidated = false;
  const service = makeService({ current: rawRow(60), onInvalidate: () => { invalidated = true; } });
  const result = await service.checkForChanges();
  assert.equal(result.checked, true);
  assert.equal(result.changed, false);
  assert.equal(invalidated, false);
  assert.ok(service.getFingerprint());
});

test('invalidates the cache when the data changes', async () => {
  let invalidated = false;
  let current = rawRow(60);
  const pool = { query: async () => ({ rows: [current] }) };
  const redis = { get: async () => null, incr: async () => 1 };
  const productService = { invalidate: async () => { invalidated = true; return { generation: 1, persisted: true }; } };
  const service = createInvalidationService(pool, redis, productService);

  await service.checkForChanges();
  current = rawRow(61);
  const result = await service.checkForChanges();
  assert.equal(result.changed, true);
  assert.equal(invalidated, true);
});

test('does not invalidate when the data is unchanged', async () => {
  let invalidated = false;
  const service = makeService({ current: rawRow(60), onInvalidate: () => { invalidated = true; } });
  await service.checkForChanges();
  const result = await service.checkForChanges();
  assert.equal(result.checked, true);
  assert.equal(result.changed, false);
  assert.equal(invalidated, false);
});

test('leaves the cache untouched when the fingerprint check fails', async () => {
  let invalidated = false;
  const pool = { query: async () => { throw new Error('database unavailable'); } };
  const redis = { get: async () => null, incr: async () => 1 };
  const productService = { invalidate: async () => { invalidated = true; return { generation: 1, persisted: true }; } };
  const service = createInvalidationService(pool, redis, productService);

  const result = await service.checkForChanges();
  assert.equal(result.checked, false);
  assert.equal(result.changed, false);
  assert.equal(invalidated, false);
});

test('manual invalidation bumps the generation and reports the reason', async () => {
  let invalidated = false;
  const service = makeService({ current: rawRow(60), onInvalidate: () => { invalidated = true; } });
  const result = await service.invalidateNow('api request');
  assert.equal(invalidated, true);
  assert.equal(result.generation, 1);
  assert.equal(result.persisted, true);
  assert.equal(result.reason, 'api request');
});
