// Contract tests use small fakes to verify cache behavior without external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductService } from '../src/services/productService.js';

test('returns cached data without querying PostgreSQL on a cache hit', async () => {
  const redis = { get: async () => JSON.stringify([{ id: 1, name: 'cached' }]), set: async () => { throw new Error('set should not run'); } };
  const pool = { query: async () => { throw new Error('database should not run'); } };
  const result = await createProductService(pool, redis).search({ query: '', category: '', page: 1, pageSize: 20 }, true);
  assert.equal(result.cacheHit, true);
  assert.deepEqual(result.data, [{ id: 1, name: 'cached' }]);
});

test('queries PostgreSQL and populates Redis on a cache miss', async () => {
  let saved;
  const redis = { get: async () => null, set: async (_key, value, mode, ttl) => { saved = { value, mode, ttl }; } };
  const pool = { query: async () => ({ rows: [{ id: 2, name: 'fresh' }] }) };
  const result = await createProductService(pool, redis).search({ query: 'fresh', category: '', page: 1, pageSize: 20 }, true);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(result.data, [{ id: 2, name: 'fresh' }]);
  assert.equal(saved.mode, 'EX');
  assert.equal(typeof saved.ttl, 'number');
});

test('uses the configured TTL when storing a cache entry', async () => {
  let saved;
  const redis = { get: async () => null, set: async (_key, value, mode, ttl) => { saved = { mode, ttl }; } };
  const pool = { query: async () => ({ rows: [] }) };
  await createProductService(pool, redis).search({ query: '', category: '', page: 1, pageSize: 20 }, true);
  assert.equal(saved.mode, 'EX');
  assert.equal(saved.ttl, 60);
});

test('reads and writes the same key for identical filters', async () => {
  const reads = [];
  const writes = [];
  const redis = { get: async (key) => { reads.push(key); return null; }, set: async (key) => { writes.push(key); } };
  const pool = { query: async () => ({ rows: [] }) };
  const filters = { query: 'keyboard', category: 'electronics', page: 1, pageSize: 20 };
  await createProductService(pool, redis).search(filters, true);
  // The first read fetches the generation counter, the second reads the
  // product entry, and the write stores it under the same product key.
  assert.equal(reads.length, 2);
  assert.equal(writes.length, 1);
  assert.equal(reads[1], writes[0]);
  assert.match(reads[1], /^shop-demo:products:\d+:/);
});

test('bypasses the cache entirely when caching is disabled', async () => {
  let read = false;
  let write = false;
  const redis = { get: async () => { read = true; return null; }, set: async () => { write = true; } };
  const pool = { query: async () => ({ rows: [] }) };
  const result = await createProductService(pool, redis).search({ query: '', category: '', page: 1, pageSize: 20 }, false);
  assert.equal(result.cacheHit, false);
  assert.equal(read, false);
  assert.equal(write, false);
});

test('falls back to PostgreSQL when the cache read fails', async () => {
  const redis = { get: async () => { throw new Error('redis unavailable'); }, set: async () => {} };
  const pool = { query: async () => ({ rows: [{ id: 3, name: 'from-database' }] }) };
  const result = await createProductService(pool, redis).search({ query: '', category: '', page: 1, pageSize: 20 }, true);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(result.data, [{ id: 3, name: 'from-database' }]);
});

test('serves the response when the cache write fails', async () => {
  const redis = { get: async () => null, set: async () => { throw new Error('redis unavailable'); } };
  const pool = { query: async () => ({ rows: [{ id: 4, name: 'fresh' }] }) };
  const result = await createProductService(pool, redis).search({ query: '', category: '', page: 1, pageSize: 20 }, true);
  assert.equal(result.cacheHit, false);
  assert.deepEqual(result.data, [{ id: 4, name: 'fresh' }]);
});
