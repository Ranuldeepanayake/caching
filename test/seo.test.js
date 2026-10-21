// SEO metadata tests verify canonical URL handling without starting the HTTP server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSitemapXml } from '../src/seo.js';

test('creates a sitemap containing the public application route', () => {
  const xml = createSitemapXml('https://example.com');
  assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
  assert.doesNotMatch(xml, /\/api/);
});
