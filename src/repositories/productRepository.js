// Database read model for the intentionally expensive ecommerce reporting query.
import { childLogger } from '../logger.js';
import { queryWithDatabaseRetry } from '../providers/postgres.js';
const log = childLogger('product-repository');

/** Deliberately expensive reporting query: joins products, categories, inventory, reviews and order history. */
export async function searchProducts(pool, { query = '', category = '', page = 1, pageSize = 20 }) {
  const offset = (page - 1) * pageSize;
  const values = [`%${query}%`, category || null, pageSize, offset];
  const sql = `
    WITH product_metrics AS (
      SELECT p.id, p.sku, p.name, p.description, p.price, c.name AS category,
             COALESCE(SUM(oi.quantity) FILTER (WHERE o.status IN ('paid','shipped','delivered')), 0)::int AS units_sold,
             ROUND(COALESCE(AVG(r.rating), 0), 2) AS average_rating,
             COALESCE(SUM(i.available_quantity), 0)::int AS available_quantity,
             COUNT(DISTINCT r.id)::int AS review_count
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN inventory i ON i.product_id = p.id
      LEFT JOIN order_items oi ON oi.product_id = p.id
      LEFT JOIN orders o ON o.id = oi.order_id
      LEFT JOIN reviews r ON r.product_id = p.id AND r.is_approved = true
      WHERE (p.name ILIKE $1 OR p.description ILIKE $1) AND ($2::text IS NULL OR c.slug = $2)
      GROUP BY p.id, c.name
    )
    SELECT *, COUNT(*) OVER()::int AS total_count,
           ROUND((price * (1 + units_sold * 0.001))::numeric, 2) AS dynamic_price
    FROM product_metrics ORDER BY units_sold DESC, average_rating DESC, id LIMIT $3 OFFSET $4`;
  const started = process.hrtime.bigint();
  const result = await queryWithDatabaseRetry(pool, sql, values);
  log.info({ rowCount: result.rowCount, durationMs: Number(process.hrtime.bigint() - started) / 1e6 }, 'product query completed');
  // COUNT(*) OVER() is calculated before LIMIT/OFFSET, so the UI can render
  // reliable pagination without fetching an extra product or issuing a second
  // count query. Remove the transport-only column before caching product data.
  const totalCount = result.rows[0]?.total_count ?? 0;
  const data = result.rows.map(({ total_count: _totalCount, ...product }) => product);
  return { data, totalCount };
}
