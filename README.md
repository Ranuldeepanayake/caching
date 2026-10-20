# Cache Lab: PostgreSQL + Redis / AWS ElastiCache

Cache Lab is a Dockerised Node.js application that makes the performance difference between a multi-table PostgreSQL query and a Redis-cached response visible in a small responsive UI. The database and cache providers are independently configurable, so self-hosted PostgreSQL can be mixed with AWS ElastiCache, or AWS RDS can be mixed with a self-hosted Redis instance.

## Architecture

The app uses Express, `pg`, and `ioredis`. `src/providers/` contains provider adapters. In AWS mode, `@aws-sdk/client-rds` discovers an RDS endpoint from `RDS_INSTANCE_IDENTIFIER`, and `@aws-sdk/client-elasticache` discovers an ElastiCache endpoint from `ELASTICACHE_REPLICATION_GROUP_ID`. Explicit `RDS_HOST` and `ELASTICACHE_HOST` values may be supplied instead, which is useful for private networking and managed Redis-compatible services. Credentials and AWS settings are environment variables; no secrets are stored in the image.

The query joins categories, products, inventory, orders, order items, and approved reviews. It aggregates sales and ratings and derives a dynamic price. This gives a realistic read-heavy workload for a cache demonstration.

## Quick start with Docker Compose

Requirements: Linux, Docker Engine, and Docker Compose v2.

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000. The first request with cache enabled is a miss and populates Redis. Repeating it should show a cache hit and a lower duration. Turn the toggle off to force PostgreSQL for comparison.

The Compose database is initialised automatically by the scripts in `db/`. To reset the demo data, run `docker compose down -v && docker compose up --build`.

## Bare-metal Linux

Install Node.js 20+ and PostgreSQL 16+ plus Redis 7+. Create a database and user, then configure the endpoints:

```bash
createdb shop
cp .env.example .env
npm ci
npm run db:migrate
npm start
```

Set `DATABASE_URL=postgres://user:password@host:5432/shop` and `REDIS_URL=redis://:password@host:6379` in `.env`. `npm run dev` enables Node's watch mode.

## AWS configuration

Choose either AWS provider independently:

```dotenv
DATABASE_PROVIDER=aws
CACHE_PROVIDER=aws
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
RDS_INSTANCE_IDENTIFIER=shop-postgres
RDS_DATABASE=shop
RDS_USERNAME=app
RDS_PASSWORD=...
ELASTICACHE_REPLICATION_GROUP_ID=shop-redis
ELASTICACHE_TLS=true
```

For least privilege, the application identity needs `rds:DescribeDBInstances` and `elasticache:DescribeReplicationGroups` when identifiers are used. The runtime also needs network access to the private RDS and ElastiCache endpoints, security-group rules allowing PostgreSQL/Redis traffic, and TLS/password settings matching the services. AWS SDK default credential resolution is supported, so IAM roles are preferred on EC2/ECS/EKS over long-lived access keys.

Provider combinations are independent: `self-hosted/self-hosted`, `aws/aws`, `aws/self-hosted`, and `self-hosted/aws` are all valid. Only one database and one cache are created by each app process.

## API

`GET /api/products?q=keyboard&category=electronics&cache=true&page=1&pageSize=20` returns `{ data, cacheHit, durationMs, filters }`. `GET /api/health` is a lightweight health endpoint. Cache keys include the complete filter object and expire after `CACHE_TTL_SECONDS` (default 60).

Set `CACHE_ENABLED=false` to deliberately run database-only. In that mode the application does not create a Redis/ElastiCache client, does not validate cache endpoint variables, and the UI toggle safely remains a no-op. When caching is enabled but Redis is temporarily unavailable, the app retries the connection in the background and serves requests directly from PostgreSQL until the cache returns.

## Schema and operations

`db/001_schema.sql` creates `categories`, `customers`, `products`, `inventory`, `orders`, `order_items`, and `reviews`, with foreign keys, checks, indexes, and a search index. `db/002_seed.sql` creates a repeatable demo dataset using conflict-safe inserts. Edit or extend these files when adding data, then apply them with `npm run db:migrate`.

Logs are JSON and include ISO timestamps, service/module context, request metadata, provider selection, cache outcome, row count, and duration. In containers, use `docker compose logs -f app` and set `LOG_LEVEL=debug` when more detail is needed. Startup logs include non-sensitive settings, endpoint-presence flags, and true/false indicators for sensitive variables such as AWS keys and database/cache passwords. Secret values are never logged.

## Development checks

```bash
npm run lint
npm test
```

The tests cover the cache hit/miss contract without external services. The runtime smoke test requires the configured database and Redis endpoints. The app intentionally fails fast at startup when required provider environment variables are missing.
