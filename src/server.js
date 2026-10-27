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
import { createInvalidationService } from './services/invalidationService.js';
import { createRouter } from './routes.js';
import { createSeoRouter } from './seo.js';

// Startup is intentionally fail-fast: configuration and dependency connectivity
// are checked before the HTTP server begins accepting product requests.
assertConfig();
logger.info(startupConfigSummary(), 'application configuration loaded');
const pool = await createPostgresPool();
const redis = await createRedisClient();
const productService = createProductService(pool, redis);
const invalidationService = createInvalidationService(pool, redis, productService);
const app = express();
const directory = path.dirname(fileURLToPath(import.meta.url));
// Request logging is installed before routes so every request receives timing,
// status, and module context in the structured container logs.
app.use(pinoHttp({ logger }));
app.use(express.json());
app.use(express.static(path.join(directory, '..', 'public')));
// Serve metadata dynamically so the same container works across local, proxy, and production domains.
app.get(['/robots.txt', '/sitemap.xml'], createSeoRouter());
app.use('/api', createRouter(productService, invalidationService));
app.use((error, _req, res, _next) => res.status(500).json({ error: 'internal_error', message: error.message }));
// The app listens on the container port; HTTPS termination belongs at the
// reverse proxy/load balancer in a production deployment.
const server = app.listen(config.port, () => logger.info({ port: config.port, databaseProvider: config.databaseProvider, cacheProvider: config.cacheProvider }, 'server listening'));
// Watch the underlying data so cached entries are invalidated when it changes.
invalidationService.start();
// Stop accepting traffic and release timers/connections so deploys do not leave
// pooled clients or Redis sockets behind.
const shutdown = async (signal) => { logger.info({ signal }, 'shutdown requested'); server.close(); invalidationService.stop(); await Promise.allSettled([pool.end(), redis?.quit()]); process.exit(0); };
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
