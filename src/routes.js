// HTTP API routes: HTTP boundary converts query-string input into typed service filters,
// handles pagination/filtering validation, and keeps transport errors separate from service logic.
import express from 'express';
import { config } from './config.js';
import { childLogger } from './logger.js';
const log = childLogger('routes');

// Create Express router with all API endpoints
// @param service - productService instance (handles search with cache-aside pattern)
// @param invalidationService - invalidationService instance (handles manual/automatic cache invalidation)
export function createRouter(service, invalidationService) {
  const router = express.Router();

  // Health check: lightweight endpoint for load balancers and orchestrators
  router.get('/health', async (_req, res) => {
    try {
      res.json({ status: 'ok' });
    } catch (error) {
      res.status(503).json({ status: 'error', message: error.message });
    }
  });

  // GET /api/products?q=keyboard&category=electronics&cache=true&page=1&pageSize=20
  // Search products with optional caching. Returns data, cacheHit, duration, pagination, and applied filters.
  router.get('/products', async (req, res, next) => {
    try {
      const pageNum = Number(req.query.page || 1);
      const pageSizeNum = Number(req.query.pageSize || config.defaultPageSize);
      const filters = { query: String(req.query.q || ''), category: String(req.query.category || ''), page: Math.max(1, Number.isInteger(pageNum) ? pageNum : 1), pageSize: Math.min(100, Math.max(1, Number.isInteger(pageSizeNum) ? pageSizeNum : config.defaultPageSize)) };
      const useCache = String(req.query.cache || 'true').toLowerCase() === 'true';
      const result = await service.search(filters, useCache);
      // Older service implementations may not provide a count. Keep the
      // response usable in that case while current queries provide exact data.
      const totalCount = Number.isInteger(result.totalCount) ? result.totalCount : null;
      const totalPages = totalCount === null ? null : Math.ceil(totalCount / filters.pageSize);
      res.json({
        ...result,
        pagination: {
          page: filters.page,
          pageSize: filters.pageSize,
          totalCount,
          totalPages,
          hasPrevious: filters.page > 1,
          hasNext: totalPages === null ? result.data.length === filters.pageSize : filters.page < totalPages
        },
        filters
      });
    } catch (error) { log.error({ err: error }, 'product request failed'); next(error); }
  });

  // POST /api/cache/invalidate
  // Manually invalidate all cached product entries on demand. Bumps generation counter
  // so all cached results become unreachable immediately. Used by UI "Invalidate cache" button.
  router.post('/cache/invalidate', async (req, res, next) => {
    try {
      if (!invalidationService) {
        res.status(503).json({ error: 'invalidation_unavailable', message: 'cache invalidation is not available' });
        return;
      }
      const result = await invalidationService.invalidateNow('api request');
      log.info({ generation: result.generation }, 'cache invalidation requested through the API');
      res.json({ invalidated: true, generation: result.generation, persisted: result.persisted, durationMs: result.durationMs });
    } catch (error) { log.error({ err: error }, 'cache invalidation failed'); next(error); }
  });

  // GET /api/cache/status
  // Report current cache configuration (enabled, TTL, prefix), automatic invalidation settings,
  // and the current data fingerprint (used by invalidation service to detect changes).
  router.get('/cache/status', async (_req, res, next) => {
    try {
      const fingerprint = invalidationService?.getFingerprint?.() ?? null;
      res.json({
        cacheEnabled: config.cacheEnabled,
        ttlSeconds: config.cacheTtlSeconds,
        keyPrefix: config.cacheKeyPrefix,
        automaticInvalidation: {
          enabled: config.cacheInvalidationEnabled,
          intervalMs: config.cacheInvalidationIntervalMs
        },
        fingerprint
      });
    } catch (error) { log.error({ err: error }, 'cache status request failed'); next(error); }
  });

  return router;
}
