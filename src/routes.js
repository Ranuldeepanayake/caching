// HTTP boundary: converts query-string input into typed service filters and
// keeps transport errors separate from database/cache implementation details.
import express from 'express';
import { config } from './config.js';
import { childLogger } from './logger.js';
const log = childLogger('routes');

export function createRouter(service) {
  const router = express.Router();
  router.get('/health', async (_req, res) => { try { res.json({ status: 'ok' }); } catch (error) { res.status(503).json({ status: 'error', message: error.message }); } });
  router.get('/products', async (req, res, next) => {
    try {
      const filters = { query: String(req.query.q || ''), category: String(req.query.category || ''), page: Math.max(1, Number(req.query.page || 1)), pageSize: Math.min(100, Math.max(1, Number(req.query.pageSize || config.defaultPageSize))) };
      const useCache = String(req.query.cache || 'true').toLowerCase() === 'true';
      const result = await service.search(filters, useCache);
      res.json({ ...result, filters });
    } catch (error) { log.error({ err: error }, 'product request failed'); next(error); }
  });
  return router;
}
