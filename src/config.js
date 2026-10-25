// Centralize environment parsing so every runtime component uses the same validated values.
// dotenv/config loads .env file into process.env on import (unless running in production with env vars set)
import 'dotenv/config';

// Parse and validate a provider name: accepts 'self-hosted' or 'aws', defaults to 'self-hosted'
// Throws if value is not recognized. Used for DATABASE_PROVIDER and CACHE_PROVIDER.
const provider = (value, name) => {
  const normalized = (value || 'self-hosted').toLowerCase();
  if (!['self-hosted', 'aws'].includes(normalized)) throw new Error(`${name} must be self-hosted or aws`);
  return normalized;
};

// Parse a positive integer (>0) or return fallback. Used for port, TTL, and other mandatory numeric settings.
// Returns fallback if value is missing, non-numeric, zero, or negative.
const positiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

// Parse a non-negative integer (>=0) or return fallback. Used for polling intervals where 0 means "disabled".
// Returns fallback only if value is non-numeric or negative.
const nonNegativeInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

// All configuration is exported as a single object. See README for environment variable reference.
export const config = {
  // Server and logging
  port: Number(process.env.APP_PORT || 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  publicBaseUrl: process.env.PUBLIC_BASE_URL,  // Used by sitemap/robots.txt; omit to derive from request

  // Provider selection: 'self-hosted' or 'aws' for both database and cache independently
  databaseProvider: provider(process.env.DATABASE_PROVIDER, 'DATABASE_PROVIDER'),
  cacheProvider: provider(process.env.CACHE_PROVIDER, 'CACHE_PROVIDER'),
  cacheEnabled: process.env.CACHE_ENABLED !== 'false',  // Set to 'false' to run database-only

  // Connection retry settings for resilience during startup
  connectionRetryAttempts: Number(process.env.CONNECTION_RETRY_ATTEMPTS || 8),
  connectionRetryBaseDelayMs: Number(process.env.CONNECTION_RETRY_BASE_DELAY_MS || 1000),

  // Self-hosted connections: standard libpq and redis:// URLs
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL,

  // AWS region and service discovery
  awsRegion: process.env.AWS_REGION || 'us-east-1',

  // RDS configuration: AWS SDK discovers endpoint from instanceIdentifier, or use explicit host
  rds: {
    instanceIdentifier: process.env.RDS_INSTANCE_IDENTIFIER,  // Looked up via @aws-sdk/client-rds
    host: process.env.RDS_HOST,                              // Alternative: explicit host (private network, etc.)
    port: Number(process.env.RDS_PORT || 5432),
    database: process.env.RDS_DATABASE || 'shop',
    username: process.env.RDS_USERNAME,
    password: process.env.RDS_PASSWORD
  },

  // ElastiCache configuration: AWS SDK discovers endpoint from replicationGroupId, or use explicit host
  elasticache: {
    replicationGroupId: process.env.ELASTICACHE_REPLICATION_GROUP_ID,  // Looked up via @aws-sdk/client-elasticache
    host: process.env.ELASTICACHE_HOST,                               // Alternative: explicit host
    port: Number(process.env.ELASTICACHE_PORT || 6379),
    tls: process.env.ELASTICACHE_TLS === 'true',
    tlsInsecure: process.env.ELASTICACHE_TLS_INSECURE === 'true',      // Skip certificate verification if true
    tlsCertPath: process.env.ELASTICACHE_TLS_CERT_PATH,                // Path to CA certificate file
    username: process.env.ELASTICACHE_USERNAME,
    password: process.env.ELASTICACHE_PASSWORD
  },

  // Self-hosted Redis TLS configuration
  redis: {
    tls: process.env.REDIS_TLS === 'true',
    tlsInsecure: process.env.REDIS_TLS_INSECURE === 'true',            // Skip certificate verification if true
    tlsCertPath: process.env.REDIS_TLS_CERT_PATH                       // Path to CA certificate file
  },

  // Cache behavior: TTL is how long a cached entry survives; generation counter invalidates stale entries
  cacheTtlSeconds: positiveInt(process.env.CACHE_TTL_SECONDS, 60),
  cacheKeyPrefix: process.env.CACHE_KEY_PREFIX || 'shop-demo',
  defaultPageSize: Number(process.env.DEFAULT_PAGE_SIZE || 20),

  // Cache invalidation: automatic detection watches for data changes; manual invalidation clears on demand
  // Generation counter is part of cache key: invalidating bumps counter, making old keys unreachable
  cacheInvalidationEnabled: process.env.CACHE_INVALIDATION_ENABLED !== 'false',
  cacheInvalidationIntervalMs: nonNegativeInt(process.env.CACHE_INVALIDATION_INTERVAL_MS, 300000)  // 0 = disabled, default 5 min
};

// Validate that all required variables are set for the chosen providers. Throws on failure.
// Called at startup (see server.js) to fail fast if configuration is incomplete.
export function assertConfig() {
  if (config.databaseProvider === 'self-hosted' && !config.databaseUrl) {
    throw new Error('DATABASE_URL is required for self-hosted database');
  }
  if (config.cacheEnabled && config.cacheProvider === 'self-hosted' && !config.redisUrl) {
    throw new Error('REDIS_URL is required for self-hosted cache');
  }
  if (config.cacheEnabled && config.cacheProvider === 'aws' && !config.elasticache.host && !config.elasticache.replicationGroupId) {
    throw new Error('ELASTICACHE_HOST or ELASTICACHE_REPLICATION_GROUP_ID is required for AWS cache');
  }
}

// Return safe startup diagnostics for logging: endpoint presence and sensitive variable flags.
// Secret values (passwords, API keys) are never included; only Boolean flags indicating if they are set.
// Logged at application startup to confirm configuration without leaking sensitive data.
export function startupConfigSummary() {
  return {
    // Non-sensitive operational settings
    port: config.port,
    logLevel: config.logLevel,
    databaseProvider: config.databaseProvider,
    cacheProvider: config.cacheProvider,
    cacheEnabled: config.cacheEnabled,
    awsRegion: config.awsRegion,
    cacheTtlSeconds: config.cacheTtlSeconds,
    connectionRetryAttempts: config.connectionRetryAttempts,
    connectionRetryBaseDelayMs: config.connectionRetryBaseDelayMs,

    // Endpoint presence flags (safe to log; shows which providers are configured)
    endpoints: {
      databaseUrlSet: Boolean(config.databaseUrl),
      redisUrlSet: Boolean(config.redisUrl),
      rdsHostSet: Boolean(config.rds.host),
      elasticacheHostSet: Boolean(config.elasticache.host)
    },

    // Sensitive variable presence flags (safe to log; only Boolean, never the actual values)
    sensitiveVariablesSet: {
      awsAccessKeyId: Boolean(process.env.AWS_ACCESS_KEY_ID),
      awsSecretAccessKey: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
      awsSessionToken: Boolean(process.env.AWS_SESSION_TOKEN),
      databaseUrl: Boolean(config.databaseUrl),
      rdsUsername: Boolean(config.rds.username),
      rdsPassword: Boolean(config.rds.password),
      elasticacheUsername: Boolean(config.elasticache.username),
      elasticachePassword: Boolean(config.elasticache.password),
      elasticacheTlsCertPath: Boolean(config.elasticache.tlsCertPath),
      redisTlsCertPath: Boolean(config.redis.tlsCertPath)
    }
  };
}
