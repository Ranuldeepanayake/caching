# Cache Lab: PostgreSQL + Redis / AWS ElastiCache

Cache Lab is a Dockerised Node.js application that makes the performance difference between a multi-table PostgreSQL query and a Redis-cached response visible in a small responsive UI. The database and cache providers are independently configurable, so self-hosted PostgreSQL can be mixed with AWS ElastiCache, or AWS RDS can be mixed with a self-hosted Redis instance.

## Architecture

The app uses Express, `pg`, and `ioredis`. `src/providers/` contains provider adapters. In AWS mode, `@aws-sdk/client-rds` discovers an RDS endpoint from `RDS_INSTANCE_IDENTIFIER`, and `@aws-sdk/client-elasticache` discovers an ElastiCache endpoint from `ELASTICACHE_REPLICATION_GROUP_ID`. Explicit `RDS_HOST` and `ELASTICACHE_HOST` values may be supplied instead, which is useful for private networking and managed Redis-compatible services. Credentials and AWS settings are environment variables; no secrets are stored in the image.

The query joins categories, products, inventory, orders, order items, and approved reviews. It aggregates sales and ratings and derives a dynamic price. This gives a realistic read-heavy workload for a cache demonstration.

Cached results are invalidated automatically when the underlying data changes, and can also be invalidated on demand from the UI. The cache TTL is configurable through an environment variable.

## Quick start with Docker Compose

Requirements: Linux, Docker Engine, and Docker Compose v2.

```bash
cp .env.example .env
docker compose up --build
```

Open http://localhost:3000. The first request with cache enabled is a miss and populates Redis. Repeating it should show a cache hit and a lower duration. Turn the toggle off to force PostgreSQL for comparison. Press **Invalidate cache** to clear the cached entries and watch the next request read PostgreSQL again.

The Compose database is initialised automatically by the scripts in `db/`. PostgreSQL 18 requires the volume to be mounted at `/var/lib/postgresql` rather than the legacy `/var/lib/postgresql/data`; the provided Compose file already uses the PostgreSQL 18-compatible mount.

If this project was previously run with the old PostgreSQL 16/legacy volume layout, the old named volume is not automatically upgraded. Because this is demo data, reset it with:

```bash
docker compose down -v
docker compose up --build
```

Do not use `down -v` if the database contains data you need. Preserve that volume and perform a PostgreSQL major-version upgrade with `pg_upgrade` or a logical backup/restore using `pg_dump` and `pg_restore`, following the PostgreSQL upgrade documentation.

Docker's PostgreSQL image runs the files in `db/` automatically only when the `postgres-data` volume is created for the first time. If the volume already exists, PostgreSQL keeps the existing database and skips those initialization files. For an existing Compose volume, use `docker compose exec app npm run db:migrate` after the application container is running, or recreate the volume if a clean demo database is required.

## Bare-metal Linux

Install Node.js 20+ and PostgreSQL 18+ plus Redis 7+. Create a database and user, then configure the endpoints:

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

## Is this like session storage?

The implementation uses the same broad Redis idea as session storage, but it is a different caching pattern.

For sessions, Redis is usually the system of record for a short-lived session object. A request reads the session by a stable key such as `session:<id>`, and the application may write updates back to Redis. Losing the session store can affect authentication or user state, so availability and expiration policy are especially important.

This application uses a cache-aside pattern for PostgreSQL query results. PostgreSQL remains the source of truth. The application checks Redis using a key derived from the query filters, queries PostgreSQL on a miss, stores the result with a TTL, and safely falls back to PostgreSQL if Redis is unavailable. The UI cache toggle controls whether that lookup/write path is used for the request.

The reusable concepts are the Redis connection, key naming, TTLs, serialization, and reconnect handling. The important differences are that product results are derived data rather than authoritative state, cache keys represent query parameters rather than users, and invalidation or short TTLs are needed when the underlying product/order data changes. A session implementation would normally add authenticated session IDs, stricter access controls, explicit logout deletion, and a policy for what happens when the session store is unavailable.

Invalidation is where the two patterns differ most. A session is deleted on logout, and its lifetime is bounded by the session itself. A cached query result has no natural end of life, so it needs either a short TTL, an explicit invalidation signal when the source data changes, or both. This application uses both: the TTL bounds how long a stale result can survive, and the generation counter in the cache key removes stale results as soon as the change is detected.

## API

`GET /api/products?q=keyboard&category=electronics&cache=true&page=1&pageSize=20` returns `{ data, cacheHit, durationMs, pagination, filters }`. The `pageSize` value is the PostgreSQL `LIMIT`: it controls how many products are queried and returned for that request, not just how many cards the browser displays. The UI and API intentionally cap `pageSize` at 100 to protect the database and response size; larger values are clamped to 100. The `pagination` object includes `page`, `pageSize`, `totalCount`, `totalPages`, `hasPrevious`, and `hasNext`, allowing the UI to paginate even when the final page is exactly full. `GET /api/health` is a lightweight health endpoint. Cache keys include the complete filter object and expire after `CACHE_TTL_SECONDS` (default 60).

`POST /api/cache/invalidate` invalidates every cached product entry on demand and returns `{ invalidated, generation, persisted, durationMs }`. `GET /api/cache/status` reports the active cache configuration and the current data fingerprint.

`/sitemap.xml` and `/robots.txt` are generated dynamically. `PUBLIC_BASE_URL` tells the application which public URL search engines and browsers should use when following sitemap links. This is important when the Node.js process runs behind Docker, a reverse proxy, a load balancer, or an HTTPS terminator, because the internal host/port may differ from the externally reachable address. For example:

```dotenv
PUBLIC_BASE_URL=https://cache.example.com
```

In production, set it to the canonical HTTPS origin so the sitemap does not publish an internal hostname, container port, or an HTTP URL. If it is omitted, the app derives the origin from the incoming request host and forwarded protocol, which is convenient for local development but depends on the proxy forwarding correct headers. The sitemap includes the public application page, while `/api/` is excluded from crawling.

Set `CACHE_ENABLED=false` to deliberately run database-only. In that mode the application does not create a Redis/ElastiCache client, does not validate cache endpoint variables, and the UI toggle safely remains a no-op. When caching is enabled but Redis is temporarily unavailable, the app retries the connection in the background and serves requests directly from PostgreSQL until the cache returns.

## Cache invalidation

Cached entries expire on their own after `CACHE_TTL_SECONDS`. Invalidation is what makes a change to the underlying data visible before that TTL elapses.

The mechanism is a **generation counter** that is part of every cache key:

```
shop-demo:products:<generation>:{"query":"keyboard","category":"electronics","page":1,"pageSize":20}
```

The counter lives in Redis under `<CACHE_KEY_PREFIX>:generation`. Invalidating the cache increments the counter, which makes every previously cached key unreachable. The next request computes a key with the new generation and misses, so it reads PostgreSQL and repopulates the cache. The stale entries are left to expire on their own TTL rather than being deleted, which keeps invalidation a single O(1) operation no matter how much is cached.

Because the counter is shared through Redis, an invalidation is effective for every application instance at once, not only for the one that served the request.

There are two ways to trigger an invalidation:

- **Automatically.** The application fingerprints the tables that feed the cached query and compares the fingerprint on a timer. When it changes, the cache is invalidated. The fingerprint is a set of row counts plus a hash of the columns the query reads, so it detects inserts, updates, and deletes without needing an `updated_at` column.
- **Manually.** The **Invalidate cache** button in the UI, or `POST /api/cache/invalidate`, forces an invalidation on demand. The next query then reads PostgreSQL, which makes the cache-miss path easy to demonstrate.

```dotenv
# How long a cached entry lives, in seconds.
CACHE_TTL_SECONDS=60
# Set to false to turn off the automatic change detection.
CACHE_INVALIDATION_ENABLED=true
# How often the data fingerprint is checked, in milliseconds. 0 disables polling.
# Default: 300000 ms (5 minutes).
CACHE_INVALIDATION_INTERVAL_MS=300000
```

A failed fingerprint check is logged and retried on the next tick rather than being treated as a change, so a transient database error cannot empty the cache.

The fingerprint hashes every row of every table the query reads, so its cost grows with the size of the data. That is fine for this dataset. For a large table, the equivalent approach is a counter row maintained by triggers, which keeps the check O(1).

## Schema and operations

`db/001_schema.sql` creates `categories`, `customers`, `products`, `inventory`, `orders`, `order_items`, and `reviews`, with foreign keys, checks, indexes, and a search index. `db/002_seed.sql` creates a repeatable demo dataset using conflict-safe inserts. Use `npm run db:migrate` for schema plus seed bootstrap, or `npm run db:seed` when the schema already exists and only the demo data should be applied.

The schema script uses `CREATE ... IF NOT EXISTS`, so existing tables are preserved. The seed script preserves existing categories, customers, products, and inventory, and does not delete or overwrite existing application data. It is not a general schema migration system: changes to existing columns or constraints must be handled with an explicit versioned migration.

### Seeded dataset

The seed is deterministic: every row is derived from a fixed generator, so running it twice produces the same dataset rather than a second copy of it.

| Table | Rows | Key |
| --- | --- | --- |
| `categories` | 3 | `slug` |
| `customers` | 250 | `email` |
| `products` | 600 | `sku` |
| `inventory` | 1 per product | product + warehouse |
| `orders` | 400 | `demo_key` |
| `order_items` | 1,200 | `demo_key` |
| `reviews` | 1,800 | `demo_key` |

`orders`, `order_items`, and `reviews` have no natural uniqueness of their own, so the seed adds a nullable `demo_key` column to each, backed by a unique index. That lets those tables use `ON CONFLICT (demo_key) DO NOTHING`, which means the demo rows can be re-applied any number of times without duplicating rows or breaking a uniqueness constraint. The columns are created by the seed script itself, so `npm run db:seed` works on its own against an existing database.

The columns are nullable on purpose. A unique index ignores NULLs, so rows created by the application are never affected and never conflict with the seeded ones.

A minority of the seeded reviews are left unapproved, so the `is_approved` filter in the product query is exercised rather than always matching everything.

Logs are JSON and include ISO timestamps, service/module context, request metadata, provider selection, cache outcome, row count, and duration. In containers, use `docker compose logs -f app` and set `LOG_LEVEL=debug` when more detail is needed. Startup logs include non-sensitive settings, endpoint-presence flags, and true/false indicators for sensitive variables such as AWS keys and database/cache passwords. Secret values are never logged.

Every product request logs `product request completed` with a `cacheHit` field, so cache hits and misses are both visible in the logs. The cache key is included, which makes it possible to confirm that an invalidation actually changed the keys in use.

## Development checks

```bash
npm run lint
npm test
```

The tests cover the cache hit/miss contract without external services. The runtime smoke test requires the configured database and Redis endpoints. The app intentionally fails fast at startup when required provider environment variables are missing.
