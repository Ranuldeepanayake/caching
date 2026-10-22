// Repository contract tests verify that the requested page size reaches SQL
// and that the window count is converted into pagination metadata.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchProducts } from '../src/repositories/productRepository.js';

test('queries exactly the requested page size and returns the full match count', async () => {
  let values;
  const pool = {
    query: async (_sql, queryValues) => {
      values = queryValues;
      return {
        rowCount: 2,
        rows: [
          { id: 8, name: 'Keyboard', total_count: 42 },
          { id: 9, name: 'Mouse', total_count: 42 }
        ]
      };
    }
  };

  const result = await searchProducts(pool, { query: 'keyboard', category: 'electronics', page: 2, pageSize: 7 });

  assert.deepEqual(values, ['%keyboard%', 'electronics', 7, 7]);
  assert.equal(result.totalCount, 42);
  assert.deepEqual(result.data, [{ id: 8, name: 'Keyboard' }, { id: 9, name: 'Mouse' }]);
});
