// Read model used to detect when the underlying product data changes.
//
// The fingerprint is a cheap summary of every table that feeds the cached
// product query: row counts plus a hash of the columns the query actually
// reads. Comparing two fingerprints tells the invalidation service whether
// anything relevant changed, without depending on an `updated_at` column that
// the schema does not have.
//
// The hash is computed with `string_agg`, so the cost grows with the number of
// rows. That is acceptable for this demo dataset. For a large table, the
// equivalent approach is a counter row maintained by triggers, so that the
// check stays O(1).
import { childLogger } from '../logger.js';
import { queryWithDatabaseRetry } from '../providers/postgres.js';
const log = childLogger('data-fingerprint');

// Each row is hashed individually and the per-row hashes are then aggregated.
// Hashing first keeps the aggregate unambiguous: the delimiter can never
// collide with row content, because a row hash is fixed-width hex.
const fingerprintSql = `
  SELECT
    (SELECT COUNT(*) FROM categories)  AS categories,
    (SELECT COUNT(*) FROM products)    AS products,
    (SELECT COUNT(*) FROM inventory)   AS inventory,
    (SELECT COUNT(*) FROM orders)      AS orders,
    (SELECT COUNT(*) FROM order_items) AS order_items,
    (SELECT COUNT(*) FROM reviews)     AS reviews,
    (SELECT COALESCE(md5(string_agg(md5(concat_ws('|', id::text, name, slug)), ' ' ORDER BY id)), '') FROM categories)  AS categories_hash,
    (SELECT COALESCE(md5(string_agg(md5(concat_ws('|', id::text, category_id::text, name, coalesce(description, ''), price::text)), ' ' ORDER BY id)), '') FROM products)    AS products_hash,
    (SELECT COALESCE(md5(string_agg(md5(concat_ws('|', id::text, product_id::text, available_quantity::text, reserved_quantity::text)), ' ' ORDER BY id)), '') FROM inventory)   AS inventory_hash,
    (SELECT COALESCE(md5(string_agg(md5(concat_ws('|', id::text, customer_id::text, status)), ' ' ORDER BY id)), '') FROM orders)      AS orders_hash,
    (SELECT COALESCE(md5(string_agg(md5(concat_ws('|', id::text, order_id::text, product_id::text, quantity::text, unit_price::text)), ' ' ORDER BY id)), '') FROM order_items) AS order_items_hash,
    (SELECT COALESCE(md5(string_agg(md5(concat_ws('|', id::text, product_id::text, rating::text, is_approved::text)), ' ' ORDER BY id)), '') FROM reviews)     AS reviews_hash`;

/**
 * Compute a fingerprint of the data that feeds the cached product query.
 * Two identical fingerprints mean nothing relevant has changed.
 */
export async function computeDataFingerprint(pool) {
  const result = await queryWithDatabaseRetry(pool, fingerprintSql, []);
  const row = result.rows[0] || {};
  const fingerprint = {
    counts: {
      categories: Number(row.categories || 0),
      products: Number(row.products || 0),
      inventory: Number(row.inventory || 0),
      orders: Number(row.orders || 0),
      orderItems: Number(row.order_items || 0),
      reviews: Number(row.reviews || 0)
    },
    hashes: {
      categories: row.categories_hash || '',
      products: row.products_hash || '',
      inventory: row.inventory_hash || '',
      orders: row.orders_hash || '',
      orderItems: row.order_items_hash || '',
      reviews: row.reviews_hash || ''
    }
  };
  log.debug({ fingerprint }, 'data fingerprint computed');
  return fingerprint;
}

/**
 * Compare two fingerprints. Returns true when any count or hash differs.
 * A missing fingerprint on either side is treated as "changed", which makes
 * the first comparison after startup invalidate once rather than never.
 */
export function fingerprintsDiffer(previous, next) {
  if (!previous || !next) return true;
  for (const key of Object.keys(next.counts)) {
    if (previous.counts[key] !== next.counts[key]) return true;
  }
  for (const key of Object.keys(next.hashes)) {
    if (previous.hashes[key] !== next.hashes[key]) return true;
  }
  return false;
}
