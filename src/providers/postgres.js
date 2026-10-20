import pg from 'pg';
import { RDSClient, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { withConnectionRetry } from './retry.js';
const { Pool } = pg;
const log = childLogger('postgres-provider');

async function resolveAwsConnection() {
  if (config.rds.host) return `postgresql://${encodeURIComponent(config.rds.username)}:${encodeURIComponent(config.rds.password)}@${config.rds.host}:${config.rds.port}/${config.rds.database}`;
  if (!config.rds.instanceIdentifier) throw new Error('RDS_HOST or RDS_INSTANCE_IDENTIFIER is required for AWS database');
  const client = new RDSClient({ region: config.awsRegion });
  const result = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: config.rds.instanceIdentifier }));
  const instance = result.DBInstances?.[0];
  if (!instance?.Endpoint?.Address) throw new Error('RDS instance has no endpoint');
  log.info({ instanceIdentifier: config.rds.instanceIdentifier, host: instance.Endpoint.Address }, 'resolved RDS endpoint');
  return `postgresql://${encodeURIComponent(config.rds.username)}:${encodeURIComponent(config.rds.password)}@${instance.Endpoint.Address}:${instance.Endpoint.Port || config.rds.port}/${config.rds.database}`;
}

export async function createPostgresPool() {
  // Resolve the endpoint and establish a real connection before the HTTP server starts.
  const connectionString = config.databaseProvider === 'aws' ? await withConnectionRetry(resolveAwsConnection, 'postgres-rds') : config.databaseUrl;
  const pool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30000 });
  pool.on('error', (error) => log.error({ err: error }, 'idle PostgreSQL client error'));
  await withConnectionRetry(async () => { const client = await pool.connect(); client.release(); }, 'postgres');
  log.info({ provider: config.databaseProvider }, 'PostgreSQL pool created');
  return pool;
}

/** Retry a query after a broken pooled connection; pg creates a replacement client. */
export function queryWithDatabaseRetry(pool, query, values) {
  return withConnectionRetry(() => pool.query(query, values), 'postgres-query');
}
