// Application composition root: validate settings, create resilient dependencies,
// mount the API/static UI, and close resources cleanly on container shutdown.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pinoHttp from 'pino-http';
import { assertConfig, config, startupConfigSummary } from './config.js';
import { logger } from './logger.js';
import { createPostgresPool } from './providers/postgres.js';
import { createRedisClient } from './providers/redis.js';
import { createProductService } from './services/productService.js';
import { createRouter } from './routes.js';

assertConfig();
logger.info(startupConfigSummary(), 'application configuration loaded');
const pool = await createPostgresPool();
const redis = await createRedisClient();
const app = express();
const directory = path.dirname(fileURLToPath(import.meta.url));
app.use(pinoHttp({ logger }));
app.use(express.json());
app.use(express.static(path.join(directory, '..', 'public')));
app.use('/api', createRouter(createProductService(pool, redis)));
app.use((error, _req, res, _next) => res.status(500).json({ error: 'internal_error', message: error.message }));
const server = app.listen(config.port, () => logger.info({ port: config.port, databaseProvider: config.databaseProvider, cacheProvider: config.cacheProvider }, 'server listening'));
const shutdown = async (signal) => { logger.info({ signal }, 'shutdown requested'); server.close(); await Promise.allSettled([pool.end(), redis?.quit()]); process.exit(0); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
