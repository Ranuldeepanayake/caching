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
