// Orchestrates cache-aside reads. Cache failures never make the product query fail.
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { searchProducts } from '../repositories/productRepository.js';
const log = childLogger('product-service');

export function createProductService(pool, redis) {
  return { async search(filters, useCache) {
    const key = `${config.cacheKeyPrefix}:products:${JSON.stringify(filters)}`;
    const started = process.hrtime.bigint();
    const cacheRequested = useCache && config.cacheEnabled && Boolean(redis);
    if (cacheRequested) {
      try {
        const cached = await redis.get(key);
        if (cached) return { data: JSON.parse(cached), cacheHit: true, durationMs: Number(process.hrtime.bigint() - started) / 1e6 };
      } catch (error) {
        // A cache outage is non-fatal: fall through to PostgreSQL and keep serving data.
        log.warn({ err: error }, 'cache read failed; bypassing cache');
      }
    }
    const data = await searchProducts(pool, filters);
    if (cacheRequested) {
      try { await redis.set(key, JSON.stringify(data), 'EX', config.cacheTtlSeconds); } catch (error) { log.warn({ err: error }, 'cache write failed; response remains valid'); }
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log.info({ cacheEnabled: cacheRequested, cacheHit: false, durationMs }, 'product request completed');
    return { data, cacheHit: false, durationMs };
  } };
}
