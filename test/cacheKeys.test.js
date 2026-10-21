// Invalidation tests cover the generation counter, the key layout, and the
// change-detection comparison. They use in-memory fakes instead of Redis and
// PostgreSQL so the suite runs without external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductKey, bumpGeneration, readGeneration } from '../src/cacheKeys.js';
import { fingerprintsDiffer } from '../src/repositories/dataFingerprintRepository.js';

const fakeRedis = () => {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    incr: async (key) => {
      const next = Number(store.get(key) || 0) + 1;
      store.set(key, String(next));
      return next;
    }
  };
};

test('builds a key from the prefix, namespace, generation and filters', () => {
  const key = buildProductKey({ query: 'keyboard', category: 'electronics', page: 1, pageSize: 20 }, 3);
  assert.match(key, /^shop-demo:products:3:/);
  assert.match(key, /"query":"keyboard"/);
});

test('produces different keys for different generations', () => {
  const filters = { query: '', category: '', page: 1, pageSize: 20 };
  assert.notEqual(buildProductKey(filters, 1), buildProductKey(filters, 2));
});

test('produces different keys for different filters', () => {
  const base = { query: '', category: '', page: 1, pageSize: 20 };
  assert.notEqual(buildProductKey(base, 1), buildProductKey({ ...base, query: 'keyboard' }, 1));
  assert.notEqual(buildProductKey(base, 1), buildProductKey({ ...base, page: 2 }, 1));
});

test('incrementing the generation invalidates previously built keys', async () => {
  const redis = fakeRedis();
  const filters = { query: '', category: '', page: 1, pageSize: 20 };
  const before = buildProductKey(filters, await readGeneration(redis));
  const { generation, persisted } = await bumpGeneration(redis);
  const after = buildProductKey(filters, await readGeneration(redis));
  assert.equal(persisted, true);
  assert.equal(generation, 1);
  assert.notEqual(before, after);
});

test('falls back to a process-local generation when the cache is unavailable', async () => {
  const before = await readGeneration(null);
  const { generation, persisted } = await bumpGeneration(null);
  assert.equal(persisted, false);
  assert.ok(generation > before);
});

test('detects a change when a row count differs', () => {
  const previous = { counts: { products: 60 }, hashes: { products: 'abc' } };
  const next = { counts: { products: 61 }, hashes: { products: 'abc' } };
  assert.equal(fingerprintsDiffer(previous, next), true);
});

test('detects a change when a hash differs', () => {
  const previous = { counts: { products: 60 }, hashes: { products: 'abc' } };
  const next = { counts: { products: 60 }, hashes: { products: 'def' } };
  assert.equal(fingerprintsDiffer(previous, next), true);
});

test('reports no change when counts and hashes are identical', () => {
  const fingerprint = { counts: { products: 60 }, hashes: { products: 'abc' } };
  assert.equal(fingerprintsDiffer(fingerprint, fingerprint), false);
});

test('treats a missing fingerprint as a change', () => {
  const fingerprint = { counts: { products: 60 }, hashes: { products: 'abc' } };
  assert.equal(fingerprintsDiffer(null, fingerprint), true);
  assert.equal(fingerprintsDiffer(fingerprint, undefined), true);
});
