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

// Parse a connection URL for diagnostics without returning userinfo,
// passwords, query secrets, or the original URL.
function connectionEndpoint(value, defaultPort) {
  if (!value) return { configured: false, host: null, port: null, scheme: null, parseError: false };
  try {
    const parsed = new URL(value);
    return { configured: true, host: parsed.hostname || null, port: Number(parsed.port || defaultPort), scheme: parsed.protocol.replace(':', ''), parseError: false };
  } catch {
    return { configured: true, host: null, port: null, scheme: null, parseError: true };
  }
}

// PostgreSQL URLs can carry SSL settings. Report their presence and mode, but
// never include the URL or any credential-bearing query values.
function postgresTlsSummary(value) {
  if (!value) return { configured: false, mode: 'not-configured', caPathSet: false, caPath: null };
  try {
    const parsed = new URL(value);
    const mode = parsed.searchParams.get('sslmode') || 'driver-default';
    const caPath = parsed.searchParams.get('sslrootcert');
    return { configured: mode !== 'disable', mode, caPathSet: Boolean(caPath), caPath: caPath || null };
  } catch {
    return { configured: false, mode: 'unparseable-url', caPathSet: false, caPath: null };
  }
}

function postgresDatabaseName(value) {
  try { return new URL(value).pathname.slice(1) || null; } catch { return null; }
}

// Reusable safe diagnostics for provider startup logs. These helpers never
// expose connection credentials or certificate contents.
export function connectionDiagnostics(value, defaultPort) {
  return { endpoint: connectionEndpoint(value, defaultPort), tls: postgresTlsSummary(value) };
}

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
  const postgresConnection = connectionDiagnostics(config.databaseUrl, 5432);
  const redisConnection = connectionEndpoint(config.redisUrl, 6379);

  return {
    // Grouping startup settings makes provider diagnostics easy to find in JSON logs.
    server: { port: config.port, logLevel: config.logLevel, publicBaseUrlSet: Boolean(config.publicBaseUrl) },
    providers: { database: config.databaseProvider, cache: config.cacheProvider, cacheEnabled: config.cacheEnabled, awsRegion: config.awsRegion },
    cache: { ttlSeconds: config.cacheTtlSeconds, invalidationEnabled: config.cacheInvalidationEnabled, invalidationIntervalMs: config.cacheInvalidationIntervalMs },
    retries: { attempts: config.connectionRetryAttempts, baseDelayMs: config.connectionRetryBaseDelayMs },

    // Endpoint fields contain host/port only. Credentials remain excluded.
    endpoints: {
      postgres: config.databaseProvider === 'self-hosted' ? { ...postgresConnection.endpoint, database: postgresDatabaseName(config.databaseUrl), source: 'DATABASE_URL' } : { configured: false, host: null, port: null, database: null, source: 'not-used' },
      rds: { configured: config.databaseProvider === 'aws', host: config.rds.host || null, port: config.rds.port, database: config.rds.database, source: config.rds.host ? 'RDS_HOST' : (config.rds.instanceIdentifier ? 'RDS_INSTANCE_IDENTIFIER' : 'not-configured') },
      redis: config.cacheProvider === 'self-hosted' ? { ...redisConnection, source: 'REDIS_URL' } : { configured: false, host: null, port: null, scheme: null, parseError: false, source: 'not-used' },
      elasticache: { configured: config.cacheEnabled && config.cacheProvider === 'aws', host: config.elasticache.host || null, port: config.elasticache.port, source: config.elasticache.host ? 'ELASTICACHE_HOST' : (config.elasticache.replicationGroupId ? 'ELASTICACHE_REPLICATION_GROUP_ID' : 'not-configured') },
      // Retain the original presence flags for existing log consumers.
      databaseUrlSet: Boolean(config.databaseUrl), redisUrlSet: Boolean(config.redisUrl), rdsHostSet: Boolean(config.rds.host), elasticacheHostSet: Boolean(config.elasticache.host)
    },
    tls: {
      postgres: config.databaseProvider === 'self-hosted' ? postgresConnection.tls : { configured: false, mode: 'not-configured-by-provider', caPathSet: false, caPath: null },
      rds: { configured: false, mode: 'not-configured-by-provider', caPathSet: false, caPath: null },
      redis: { enabled: config.redis.tls, insecure: config.redis.tlsInsecure, certificateVerification: config.redis.tls ? !config.redis.tlsInsecure : false, caPathSet: Boolean(config.redis.tlsCertPath), caPath: config.redis.tlsCertPath || null },
      elasticache: { enabled: config.elasticache.tls, insecure: config.elasticache.tlsInsecure, certificateVerification: config.elasticache.tls ? !config.elasticache.tlsInsecure : false, caPathSet: Boolean(config.elasticache.tlsCertPath), caPath: config.elasticache.tlsCertPath || null }
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
