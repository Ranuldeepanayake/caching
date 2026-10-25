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

// Normalize cached entries so deployments can safely read entries written by
// an older version that stored only an array of products.
function normalizeResult(value, fallbackPageSize = 20) {
  if (Array.isArray(value)) {
    return { data: value, totalCount: value.length < fallbackPageSize ? value.length : null };
  }
  return { data: value?.data ?? [], totalCount: value?.totalCount ?? 0 };
}

export function createProductService(pool, redis) {
  /**
   * Read the product list, using the cache when it is enabled and available.
   *
   * The returned object always reports `cacheHit` and `durationMs`, whether the
   * data came from Redis or from PostgreSQL, so the UI can compare both paths.
   */
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

    /**
     * Invalidate every cached product entry.
     *
     * The generation counter is incremented, which makes all existing keys
     * unreachable. Stale keys are not deleted immediately; they are left to
     * expire on their own TTL. This keeps invalidation a single O(1)
     * operation regardless of how much is cached.
     */
    async invalidate() {
      const started = process.hrtime.bigint();
      const { generation, persisted } = await bumpGeneration(redis);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      log.info({ generation, persisted, durationMs }, 'cache invalidated');
      return { generation, persisted, durationMs };
    }
  };
}
