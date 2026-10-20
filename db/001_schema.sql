-- Core ecommerce schema: normalized tables and indexes make the cacheable read realistic.
CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, full_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS products (id SERIAL PRIMARY KEY, category_id INT NOT NULL REFERENCES categories(id), sku TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT, price NUMERIC(10,2) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, product_id INT NOT NULL REFERENCES products(id), warehouse TEXT NOT NULL, available_quantity INT NOT NULL, reserved_quantity INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id), status TEXT NOT NULL CHECK (status IN ('pending','paid','shipped','delivered','cancelled')), ordered_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(id), product_id INT NOT NULL REFERENCES products(id), quantity INT NOT NULL, unit_price NUMERIC(10,2) NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, customer_id INT NOT NULL REFERENCES customers(id), product_id INT NOT NULL REFERENCES products(id), rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5), review_text TEXT, is_approved BOOLEAN NOT NULL DEFAULT true);
CREATE INDEX IF NOT EXISTS products_search_idx ON products USING GIN (to_tsvector('simple', name || ' ' || coalesce(description,'')));
CREATE INDEX IF NOT EXISTS categories_slug_idx ON categories(slug);
CREATE INDEX IF NOT EXISTS orders_product_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS reviews_product_approved_idx ON reviews(product_id, is_approved);
