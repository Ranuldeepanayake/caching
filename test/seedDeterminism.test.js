// Deterministic model of the seed script.
//
// The seed is SQL, so it cannot be executed without a PostgreSQL server. This
// test reimplements the same generators in JavaScript and checks the
// properties the seed is supposed to guarantee: the expected record counts,
// determinism across runs, and unique keys that satisfy the unique indexes.
//
// The SQL and this model are written to match. If the seed changes, this
// model should change with it.
import test from 'node:test';
import assert from 'node:assert/strict';

const CUSTOMER_COUNT = 250;
const PRODUCT_COUNT = 600;
const ORDER_COUNT = 400;
const ITEMS_PER_ORDER = 3;
const REVIEWS_PER_PRODUCT = 3;

const CATEGORY_SLUGS = ['electronics', 'home-office', 'outdoor'];

/** Mirror of the categories seed. */
const seedCategories = () => CATEGORY_SLUGS.map((slug, index) => ({ id: index + 1, slug }));

/** Mirror of the customers seed. */
const seedCustomers = () => Array.from({ length: CUSTOMER_COUNT }, (_, index) => {
  const n = index + 1;
  return { id: n, email: `customer${n}@example.com` };
});

/** Mirror of the products seed. */
const seedProducts = () => {
  const categories = seedCategories();
  return Array.from({ length: PRODUCT_COUNT }, (_, index) => {
    const n = index + 1;
    const category = categories[(n - 1) % categories.length];
    return { id: n, sku: `SKU-${n}`, category_id: category.id };
  });
};

/**
 * Mirror of the product-number extraction used by the reviews seed.
 * The SQL strips anything that is not a digit before casting, so a SKU
 * without a numeric segment yields 0 rather than raising an error.
 */
const productNumber = (sku) => {
  const digits = String(sku).split('-')[1].replace(/[^0-9]/g, '');
  return digits === '' ? 0 : Number(digits);
};

/** Mirror of the orders seed. */
const seedOrders = () => {
  const customers = seedCustomers();
  const statuses = ['paid', 'shipped', 'delivered', 'delivered', 'cancelled'];
  return Array.from({ length: ORDER_COUNT }, (_, index) => {
    const n = index + 1;
    const customer = customers[(n - 1) % customers.length];
    return { id: n, customer_id: customer.id, status: statuses[1 + (n % 5)], demo_key: `order-${n}` };
  });
};

/** Mirror of the order items seed. */
const seedOrderItems = () => {
  const orders = seedOrders();
  const products = seedProducts();
  // The product is chosen from a single running item number, so the selection
  // sweeps the whole product range rather than only the first few hundred.
  let itemNumber = 0;
  return orders.flatMap((order) =>
    Array.from({ length: ITEMS_PER_ORDER }, (_, index) => {
      const n = index + 1;
      itemNumber += 1;
      const product = products[(itemNumber - 1) % products.length];
      return {
        order_id: order.id,
        product_id: product.id,
        quantity: 1 + (n % 4),
        demo_key: `order-item-${order.demo_key}-${n}`
      };
    })
  );
};

/** Mirror of the reviews seed. */
const seedReviews = () => {
  const products = seedProducts();
  const customers = seedCustomers();
  return products.flatMap((product, productIndex) =>
    Array.from({ length: REVIEWS_PER_PRODUCT }, (_, index) => {
      const n = index + 1;
      const customer = customers[(productIndex + n) % customers.length];
      const productNo = productNumber(product.sku);
      return {
        customer_id: customer.id,
        product_id: product.id,
        rating: 1 + ((productNo + n - 1) % 5),
        is_approved: (productNo + n) % 10 !== 0,
        demo_key: `review-${product.sku}-${n}`
      };
    })
  );
};

test('the seed creates the documented number of records', () => {
  assert.equal(seedCategories().length, 3);
  assert.equal(seedCustomers().length, CUSTOMER_COUNT);
  assert.equal(seedProducts().length, PRODUCT_COUNT);
  assert.equal(seedOrders().length, ORDER_COUNT);
  assert.equal(seedOrderItems().length, ORDER_COUNT * ITEMS_PER_ORDER);
  assert.equal(seedReviews().length, PRODUCT_COUNT * REVIEWS_PER_PRODUCT);
});

test('the seed is deterministic across runs', () => {
  assert.deepEqual(seedProducts(), seedProducts());
  assert.deepEqual(seedOrders(), seedOrders());
  assert.deepEqual(seedOrderItems(), seedOrderItems());
  assert.deepEqual(seedReviews(), seedReviews());
});

test('every demo key is unique, so the unique index never conflicts', () => {
  const orders = seedOrders().map((row) => row.demo_key);
  const items = seedOrderItems().map((row) => row.demo_key);
  const reviews = seedReviews().map((row) => row.demo_key);
  assert.equal(new Set(orders).size, orders.length);
  assert.equal(new Set(items).size, items.length);
  assert.equal(new Set(reviews).size, reviews.length);
});

test('the sku and email values are unique', () => {
  const skus = seedProducts().map((row) => row.sku);
  const emails = seedCustomers().map((row) => row.email);
  assert.equal(new Set(skus).size, skus.length);
  assert.equal(new Set(emails).size, emails.length);
});

test('re-applying the seed would not create a duplicate row', () => {
  // The conflict target is the demo key, so a second run of the same
  // generator must produce exactly the same keys.
  const first = seedOrderItems().map((row) => row.demo_key).sort();
  const second = seedOrderItems().map((row) => row.demo_key).sort();
  assert.deepEqual(first, second);
});

test('every seeded row references a row that exists', () => {
  const customerIds = new Set(seedCustomers().map((row) => row.id));
  const productIds = new Set(seedProducts().map((row) => row.id));
  const orderIds = new Set(seedOrders().map((row) => row.id));

  for (const order of seedOrders()) {
    assert.ok(customerIds.has(order.customer_id), `order ${order.id} has no customer`);
  }
  for (const item of seedOrderItems()) {
    assert.ok(orderIds.has(item.order_id), `order item ${item.demo_key} has no order`);
    assert.ok(productIds.has(item.product_id), `order item ${item.demo_key} has no product`);
  }
  for (const review of seedReviews()) {
    assert.ok(customerIds.has(review.customer_id), `review ${review.demo_key} has no customer`);
    assert.ok(productIds.has(review.product_id), `review ${review.demo_key} has no product`);
  }
});

test('some reviews are left unapproved so the query filter is exercised', () => {
  const reviews = seedReviews();
  const unapproved = reviews.filter((review) => !review.is_approved);
  assert.ok(unapproved.length > 0, 'expected some unapproved reviews');
  assert.ok(unapproved.length < reviews.length, 'expected some approved reviews');
});

test('every product is covered by at least one order item and one review', () => {
  const productsWithItems = new Set(seedOrderItems().map((row) => row.product_id));
  const productsWithReviews = new Set(seedReviews().map((row) => row.product_id));
  assert.equal(productsWithItems.size, PRODUCT_COUNT);
  assert.equal(productsWithReviews.size, PRODUCT_COUNT);
});

test('the seeded data is large enough to be worth caching', () => {
  // A dataset that is too small would make the cache look artificially good.
  const totalRows = seedCategories().length + seedCustomers().length + seedProducts().length
    + seedOrderItems().length + seedReviews().length + seedOrders().length;
  assert.ok(totalRows > 3000, `expected a substantial dataset, got ${totalRows} rows`);
});

test('a sku without a numeric segment yields a product number of zero', () => {
  // The reviews seed derives the product number from the SKU. A product
  // created by the application may have any SKU, so the extraction must not
  // raise an error for a SKU that has no number in it.
  assert.equal(productNumber('SKU-42'), 42);
  assert.equal(productNumber('SKU-abc'), 0);
  assert.equal(productNumber('CUSTOM-SKU'), 0);
  assert.equal(productNumber('SKU-1A2'), 12);
});
