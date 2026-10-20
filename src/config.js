// Centralize environment parsing so every runtime component uses the same validated values.
import 'dotenv/config';

/** Parse and validate a provider name in one place. */
const provider = (value, name) => {
  const normalized = (value || 'self-hosted').toLowerCase();
  if (!['self-hosted', 'aws'].includes(normalized)) throw new Error(`${name} must be self-hosted or aws`);
  return normalized;
};

export const config = {
  // Non-sensitive operational settings.
  port: Number(process.env.APP_PORT || 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  databaseProvider: provider(process.env.DATABASE_PROVIDER, 'DATABASE_PROVIDER'),
  cacheProvider: provider(process.env.CACHE_PROVIDER, 'CACHE_PROVIDER'),
  cacheEnabled: process.env.CACHE_ENABLED !== 'false',
  connectionRetryAttempts: Number(process.env.CONNECTION_RETRY_ATTEMPTS || 8),
  connectionRetryBaseDelayMs: Number(process.env.CONNECTION_RETRY_BASE_DELAY_MS || 1000),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  rds: { instanceIdentifier: process.env.RDS_INSTANCE_IDENTIFIER, host: process.env.RDS_HOST, port: Number(process.env.RDS_PORT || 5432), database: process.env.RDS_DATABASE || 'shop', username: process.env.RDS_USERNAME, password: process.env.RDS_PASSWORD },
  elasticache: { replicationGroupId: process.env.ELASTICACHE_REPLICATION_GROUP_ID, host: process.env.ELASTICACHE_HOST, port: Number(process.env.ELASTICACHE_PORT || 6379), tls: process.env.ELASTICACHE_TLS === 'true', username: process.env.ELASTICACHE_USERNAME, password: process.env.ELASTICACHE_PASSWORD },
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS || 60),
  cacheKeyPrefix: process.env.CACHE_KEY_PREFIX || 'shop-demo',
  defaultPageSize: Number(process.env.DEFAULT_PAGE_SIZE || 20)
};

export function assertConfig() {
  if (config.databaseProvider === 'self-hosted' && !config.databaseUrl) throw new Error('DATABASE_URL is required for self-hosted database');
  if (config.cacheEnabled && config.cacheProvider === 'self-hosted' && !config.redisUrl) throw new Error('REDIS_URL is required for self-hosted cache');
  if (config.cacheEnabled && config.cacheProvider === 'aws' && !config.elasticache.host && !config.elasticache.replicationGroupId) throw new Error('ELASTICACHE_HOST or ELASTICACHE_REPLICATION_GROUP_ID is required for AWS cache');
}

/** Return safe startup diagnostics: values are never included for secrets. */
export function startupConfigSummary() {
  return {
    port: config.port,
    logLevel: config.logLevel,
    databaseProvider: config.databaseProvider,
    cacheProvider: config.cacheProvider,
    cacheEnabled: config.cacheEnabled,
    awsRegion: config.awsRegion,
    cacheTtlSeconds: config.cacheTtlSeconds,
    connectionRetryAttempts: config.connectionRetryAttempts,
    connectionRetryBaseDelayMs: config.connectionRetryBaseDelayMs,
    endpoints: { databaseUrlSet: Boolean(config.databaseUrl), redisUrlSet: Boolean(config.redisUrl), rdsHostSet: Boolean(config.rds.host), elasticacheHostSet: Boolean(config.elasticache.host) },
    sensitiveVariablesSet: { awsAccessKeyId: Boolean(process.env.AWS_ACCESS_KEY_ID), awsSecretAccessKey: Boolean(process.env.AWS_SECRET_ACCESS_KEY), awsSessionToken: Boolean(process.env.AWS_SESSION_TOKEN), databaseUrl: Boolean(config.databaseUrl), rdsUsername: Boolean(config.rds.username), rdsPassword: Boolean(config.rds.password), elasticacheUsername: Boolean(config.elasticache.username), elasticachePassword: Boolean(config.elasticache.password) }
  };
}
