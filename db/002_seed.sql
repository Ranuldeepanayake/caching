-- Repeatable demo data: conflict-safe inserts keep container restarts harmless.
--
-- Every row is derived from a deterministic generator, so running this script
-- twice produces the same dataset rather than a second copy of it. Rows that
-- carry a `demo_key` are protected by a unique index, so they can be
-- re-applied with `ON CONFLICT (demo_key) DO NOTHING` instead of being
-- skipped wholesale when the target table is not empty.
--
-- The seed never deletes or overwrites existing application data.
--
-- Three conventions keep a re-seed clean:
--
--   * The SKU and email formats match the ones the demo shipped with, so an
--     already-seeded database keeps its existing rows instead of gaining a
--     parallel set of near-identical ones.
--
--   * The `demo_key` columns and their unique indexes are created here rather
--     than in the schema file, so `npm run db:seed` works on its own against
--     an existing database without a separate migration step.
--
--   * Each SELECT ends with `WHERE true`. PostgreSQL parses
--     `INSERT ... SELECT ... ON CONFLICT` ambiguously when the SELECT has no
--     WHERE clause, because the trailing `ON` could belong to a join. The
--     explicit predicate removes that ambiguity.
--
-- Row selection uses a numbered CTE rather than `LIMIT ... OFFSET`, because an
-- offset built from a nullable value is a runtime error in PostgreSQL, and
-- because a row number stays correct even when ids are not contiguous.

-- Deterministic demo keys.
--
-- `orders`, `order_items` and `reviews` have no natural uniqueness of their
-- own, so the seed cannot use `ON CONFLICT` against a business key. These
-- columns give each seeded row a stable, reproducible key, which lets the
-- demo data be re-applied any number of times without duplicating rows.
--
-- The columns are nullable on purpose: rows created by the application are
-- unaffected, and a unique index ignores NULLs, so rows that predate this
-- column never conflict with the seeded ones.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS demo_key TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS demo_key TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS demo_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS orders_demo_key_idx ON orders(demo_key);
CREATE UNIQUE INDEX IF NOT EXISTS order_items_demo_key_idx ON order_items(demo_key);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_demo_key_idx ON reviews(demo_key);

-- Categories: stable slugs, so re-running keeps the same three rows.
INSERT INTO categories(name,slug) VALUES ('Electronics','electronics'),('Home Office','home-office'),('Outdoor','outdoor') ON CONFLICT (slug) DO NOTHING;

-- Customers: 250 deterministic customers keyed by email.
INSERT INTO customers(email,full_name)
SELECT 'customer' || n || '@example.com', 'Customer ' || n
FROM generate_series(1,250) n
WHERE true
ON CONFLICT (email) DO NOTHING;

-- Products: 600 deterministic products keyed by SKU. The category is assigned
-- round-robin from the three seeded categories, so the distribution is stable.
INSERT INTO products(category_id,sku,name,description,price)
SELECT c.id,
       'SKU-' || n,
       CASE WHEN n%5=0 THEN 'Mechanical Keyboard ' || n
            WHEN n%5=1 THEN 'Wireless Headphones ' || n
            WHEN n%5=2 THEN 'Ergonomic Desk Lamp ' || n
            WHEN n%5=3 THEN 'Outdoor Tent ' || n
            ELSE 'Standing Desk ' || n END,
       'High quality ecommerce product with durable materials and thoughtful design. Variant ' || n || '.',
       (20 + n * 3.75)::numeric
FROM generate_series(1,600) n
JOIN categories c
  ON c.slug = (ARRAY['electronics','home-office','outdoor'])[1 + ((n - 1) % 3)]
WHERE true
ON CONFLICT (sku) DO NOTHING;

-- Inventory: one row per product, so every product can be reported on. The
-- NOT EXISTS guard keeps the existing warehouse quantities for a product that
-- already has inventory, so re-running never duplicates stock rows.
INSERT INTO inventory(product_id,warehouse,available_quantity,reserved_quantity)
SELECT id,'Colombo',100+(id%30),id%8 FROM products p
WHERE NOT EXISTS (SELECT 1 FROM inventory i WHERE i.product_id=p.id);

-- Orders: 400 deterministic orders. `demo_key` makes the row idempotent, so
-- the insert no longer depends on the orders table being empty.
INSERT INTO orders(customer_id,status,ordered_at,demo_key)
WITH numbered_customers AS (
  SELECT id, row_number() OVER (ORDER BY email) AS rn, count(*) OVER () AS total FROM customers
)
SELECT c.id,
       (ARRAY['paid','shipped','delivered','delivered','cancelled'])[1+(series.n%5)],
       now() - (series.n * interval '1 hour'),
       'order-' || series.n
FROM generate_series(1,400) AS series(n)
JOIN numbered_customers c
  ON c.rn = 1 + ((series.n - 1) % GREATEST(c.total, 1))
WHERE true
ON CONFLICT (demo_key) DO NOTHING;

-- Order items: 1,200 deterministic order items across the seeded orders. Each
-- item carries a `demo_key` so the insert is idempotent.
--
-- Only seeded orders are used, so demo line items are never attached to an
-- order created by the application.
--
-- The product is chosen from a single running item number rather than from
-- the order number, so the selection sweeps the whole product range. Using
-- the order number instead would only ever reach the first few hundred
-- products, leaving the rest with no sales history at all.
INSERT INTO order_items(order_id,product_id,quantity,unit_price,demo_key)
WITH seeded_orders AS (
  SELECT id, demo_key, row_number() OVER (ORDER BY demo_key) AS order_no FROM orders WHERE demo_key IS NOT NULL
),
numbered_products AS (
  SELECT id, price, row_number() OVER (ORDER BY sku) AS rn, count(*) OVER () AS total FROM products
),
expanded AS (
  SELECT o.id, o.demo_key, series.n,
         row_number() OVER (ORDER BY o.order_no, series.n) AS item_no
  FROM seeded_orders o
  CROSS JOIN generate_series(1,3) AS series(n)
)
SELECT e.id,
       p.id,
       1 + (e.n % 4),
       p.price,
       'order-item-' || e.demo_key || '-' || e.n
FROM expanded e
JOIN numbered_products p
  ON p.rn = 1 + ((e.item_no - 1) % GREATEST(p.total, 1))
WHERE true
ON CONFLICT (demo_key) DO NOTHING;

-- Reviews: 1,800 deterministic reviews across the products. Each review
-- carries a `demo_key` so the insert is idempotent. A minority are left
-- unapproved so the `is_approved` filter in the product query is exercised.
--
-- The product number is derived from the SKU, which is a text column, so the
-- extraction is guarded: a product created by the application may have a SKU
-- without a numeric segment, and casting that directly would raise an error.
INSERT INTO reviews(customer_id,product_id,rating,review_text,is_approved,demo_key)
WITH numbered_products AS (
  SELECT id, sku,
         COALESCE(NULLIF(regexp_replace(split_part(sku,'-',2), '[^0-9]', '', 'g'), '')::int, 0) AS product_no,
         row_number() OVER (ORDER BY sku) AS rn, count(*) OVER () AS total FROM products
),
numbered_customers AS (
  SELECT id, row_number() OVER (ORDER BY email) AS rn, count(*) OVER () AS total FROM customers
)
SELECT c.id,
       p.id,
       1 + ((p.product_no + series.n - 1) % 5),
       'Useful and well made. Review ' || series.n || '.',
       ((p.product_no + series.n) % 10 <> 0),
       'review-' || p.sku || '-' || series.n
FROM numbered_products p
CROSS JOIN generate_series(1,3) AS series(n)
JOIN numbered_customers c
  ON c.rn = 1 + ((p.product_no + series.n - 1) % GREATEST(c.total, 1))
WHERE true
ON CONFLICT (demo_key) DO NOTHING;
