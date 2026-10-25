// Orchestrates cache-aside reads. Cache failures never make the product query fail.
//
// The read path is cache-aside: ask Redis for the key, and on a miss run the
// PostgreSQL query and store the result with a TTL. The key includes the
// current generation counter, so invalidation works by bumping that counter
// rather than by deleting individual keys.
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { searchProducts } from '../repositories/productRepository.js';
import { buildProductKey, bumpGeneration, readGeneration } from '../cacheKeys.js';
const log = childLogger('product-service');

// Normalize cached entries for forward/backward compatibility: older versions may have
// stored only an array; newer versions store {data, totalCount}. Handles both formats.
function normalizeResult(value, fallbackPageSize = 20) {
  if (Array.isArray(value)) {
    return { data: value, totalCount: value.length < fallbackPageSize ? value.length : null };
  }
  return { data: value?.data ?? [], totalCount: value?.totalCount ?? 0 };
}

// Create and return productService instance. Handles cache-aside reads: check Redis on cache hit,
// fall back to PostgreSQL on cache miss, and populate Redis with results.
// @param pool - PostgreSQL connection pool (used for searchProducts queries)
// @param redis - Redis client (or null if caching is disabled)
export function createProductService(pool, redis) {
  // Implements cache-aside pattern for product searches
  // @param filters - {query, category, page, pageSize} - search parameters
  // @param useCache - boolean - whether to use cache for this request
  // @returns {data, totalCount, cacheHit, durationMs} - product results with cache metrics
  return {
    async search(filters, useCache) {
      const started = process.hrtime.bigint();
      const cacheRequested = useCache && config.cacheEnabled && Boolean(redis);
      // The generation is read on every request so that an invalidation issued
      // by another instance takes effect without restarting this one.
      const generation = cacheRequested ? await readGeneration(redis) : 0;
      const key = buildProductKey(filters, generation);

      if (cacheRequested) {
        try {
          const cached = await redis.get(key);
          if (cached) {
            const result = normalizeResult(JSON.parse(cached), filters.pageSize);
            const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
            log.info({ cacheEnabled: true, cacheHit: true, durationMs, key }, 'product request completed');
            return { ...result, cacheHit: true, durationMs };
          }
        } catch (error) {
          // A cache outage is non-fatal: fall through to PostgreSQL and keep serving data.
          log.warn({ err: error }, 'cache read failed; bypassing cache');
        }
      }

      const result = normalizeResult(await searchProducts(pool, filters), filters.pageSize);
      if (cacheRequested) {
        try {
          await redis.set(key, JSON.stringify(result), 'EX', config.cacheTtlSeconds);
        } catch (error) {
          log.warn({ err: error }, 'cache write failed; response remains valid');
        }
      }
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      log.info({ cacheEnabled: cacheRequested, cacheHit: false, durationMs, key }, 'product request completed');
      return { ...result, cacheHit: false, durationMs };
    },

    // Manually invalidate all cached entries by incrementing the generation counter.
    // Existing cache keys include the old generation and become unreachable immediately.
    // Stale keys are left to expire on their own TTL rather than being deleted.
    // This keeps invalidation O(1) regardless of cache size.
    // @returns {generation, persisted, durationMs} - new generation number and operation timing
    async invalidate() {
      const started = process.hrtime.bigint();
      const { generation, persisted } = await bumpGeneration(redis);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      log.info({ generation, persisted, durationMs }, 'cache invalidated');
      return { generation, persisted, durationMs };
    }
  };
}
