// Cache key construction and invalidation bookkeeping.
//
// Every cache key in the application is built here so that a single module
// owns the naming scheme. The key layout is:
//
//   <prefix>:<namespace>:<generation>:<JSON of filters>
//
// The `generation` segment is the invalidation mechanism. It is a counter that
// is incremented whenever the underlying product data changes. Because the
// counter is part of the key, incrementing it makes every previously cached
// entry unreachable without needing to enumerate them first: the next request
// computes a new key and misses, while the stale entries are left to expire
// on their own TTL.
//
// The generation lives in Redis so that it is shared by every process that
// talks to the same cache. That keeps multi-instance deployments consistent
// with one another, and it makes a manual invalidation effective immediately
// for every instance rather than only for the one that received the request.
import { config } from './config.js';
import { childLogger } from './logger.js';

const log = childLogger('cache-keys');

// Key holding the current generation counter. It intentionally has no
// generation segment of its own, so it is never invalidated by a bump.
const generationKey = () => `${config.cacheKeyPrefix}:generation`;

// Process-local fallback used when Redis is unavailable. It keeps invalidation
// working inside a single process even when the shared counter is unreachable.
let localGeneration = 0;

/**
 * Read the current generation counter.
 * Falls back to the process-local counter when Redis cannot be reached, so a
 * cache outage degrades to "no shared invalidation" rather than an error.
 */
export async function readGeneration(redis) {
  if (!redis) return localGeneration;
  try {
    const value = await redis.get(generationKey());
    if (value === null || value === undefined) return localGeneration;
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : localGeneration;
  } catch (error) {
    log.warn({ err: error }, 'cache generation read failed; using process-local generation');
    return localGeneration;
  }
}

/**
 * Increment the generation counter so that all existing cache entries become
 * unreachable.
 *
 * Returns `{ generation, persisted }`. `persisted` is false when the counter
 * could not be written to Redis; callers use that to retry the invalidation
 * later instead of assuming it took effect everywhere.
 */
export async function bumpGeneration(redis) {
  localGeneration += 1;
  if (!redis) return { generation: localGeneration, persisted: false };
  try {
    const value = await redis.incr(generationKey());
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`unexpected generation value: ${value}`);
    localGeneration = parsed;
    log.info({ generation: parsed }, 'cache generation incremented; previous entries invalidated');
    return { generation: parsed, persisted: true };
  } catch (error) {
    // The counter could not be persisted, so other processes keep using the
    // old generation. The local counter still invalidates this process.
    log.error({ err: error, localGeneration }, 'cache generation increment failed');
    return { generation: localGeneration, persisted: false };
  }
}

/**
 * Build the cache key for a product search.
 * The filters object is serialised as JSON, which keeps the key readable and
 * guarantees that two identical filter sets always produce the same key.
 */
export function buildProductKey(filters, generation) {
  return `${config.cacheKeyPrefix}:products:${generation}:${JSON.stringify(filters)}`;
}
