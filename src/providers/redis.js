import Redis from 'ioredis';
import { ElastiCacheClient, DescribeReplicationGroupsCommand } from '@aws-sdk/client-elasticache';
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { withConnectionRetry } from './retry.js';
const log = childLogger('redis-provider');

async function resolveAwsRedis() {
  if (config.elasticache.host) return { host: config.elasticache.host, port: config.elasticache.port };
  if (!config.elasticache.replicationGroupId) throw new Error('ELASTICACHE_HOST or ELASTICACHE_REPLICATION_GROUP_ID is required for AWS cache');
  const client = new ElastiCacheClient({ region: config.awsRegion });
  const result = await client.send(new DescribeReplicationGroupsCommand({ ReplicationGroupId: config.elasticache.replicationGroupId }));
  const group = result.ReplicationGroups?.[0];
  const endpoint = group?.ConfigurationEndpoint || group?.NodeGroups?.[0]?.PrimaryEndpoint;
  if (!endpoint?.Address) throw new Error('ElastiCache replication group has no endpoint');
  log.info({ replicationGroupId: config.elasticache.replicationGroupId, host: endpoint.Address }, 'resolved ElastiCache endpoint');
  return { host: endpoint.Address, port: endpoint.Port || config.elasticache.port };
}

export async function createRedisClient() {
  // Disabled cache mode deliberately creates no Redis client and therefore no reconnect loop.
  if (!config.cacheEnabled) {
    log.info({ provider: config.cacheProvider }, 'cache disabled; Redis connection will not be created');
    return null;
  }
  const endpoint = config.cacheProvider === 'self-hosted' ? new URL(config.redisUrl) : await withConnectionRetry(resolveAwsRedis, 'aws-elasticache');
  const client = new Redis({
    ...(endpoint instanceof URL ? { host: endpoint.hostname, port: Number(endpoint.port || 6379), username: endpoint.username || undefined, password: endpoint.password || undefined, tls: endpoint.protocol === 'rediss:' ? {} : undefined } : endpoint),
    username: config.elasticache.username || undefined,
    password: config.elasticache.password || undefined,
    tls: config.elasticache.tls ? {} : undefined,
    // Keep retrying after runtime disconnects; the service can continue using PostgreSQL.
    retryStrategy: (attempt) => Math.min(config.connectionRetryBaseDelayMs * (2 ** Math.min(attempt - 1, 6)), 30000),
    maxRetriesPerRequest: null,
    lazyConnect: false
  });
  client.on('connect', () => log.info({ provider: config.cacheProvider }, 'Redis connection established'));
  client.on('ready', () => log.info({ provider: config.cacheProvider }, 'Redis connection ready'));
  client.on('reconnecting', (delayMs) => log.warn({ delayMs, provider: config.cacheProvider }, 'Redis reconnecting'));
  client.on('error', (error) => log.error({ err: error }, 'Redis connection error'));
  await withConnectionRetry(() => client.ping(), 'redis');
  return client;
}
