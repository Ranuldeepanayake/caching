// Browser client for the comparison workflow: submit identical filters with
// cache enabled/disabled and render timing plus cache status beside each result.
// The invalidate button clears the cached entries so the next query reads
// PostgreSQL again, which makes the cache-miss path easy to demonstrate.
const $ = (id) => document.getElementById(id);
let currentPage = 1;
let lastResult = null;
async function run(page = 1) {
  currentPage = page;
  const pageSizeInput = Number($('pageSize').value);
  const pageSize = Number.isInteger(pageSizeInput) && pageSizeInput >= 1 && pageSizeInput <= 100 ? pageSizeInput : 20;
  const params = new URLSearchParams({ q: $('query').value, category: $('category').value, page, pageSize, cache: $('cache').checked });
  $('status').textContent = 'Querying…';
  $('run').disabled = true;
  try {
    const response = await fetch(`/api/products?${params}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Request failed');
    lastResult = result;
    const pagination = result.pagination || { totalCount: null };
    const totalLabel = pagination.totalCount === null ? `${result.data.length} products` : `${pagination.totalCount} matching products`;
    $('status').innerHTML = `<strong>${result.cacheHit ? 'Cache hit' : 'Database query'}</strong> · ${result.durationMs.toFixed(2)} ms · ${result.data.length} products shown · ${totalLabel}`;
    $('results').innerHTML = result.data.map((p) => `<article class="card"><span class="badge ${result.cacheHit ? '' : 'miss'}">${result.cacheHit ? 'CACHED' : 'FRESH'}</span><h3>${escapeHtml(p.name)}</h3><p class="meta">${escapeHtml(p.category)} · ${p.sku}</p><p>${escapeHtml(p.description || '')}</p><p class="price">$${p.dynamic_price} <small>(${p.units_sold} sold)</small></p><p class="meta">★ ${p.average_rating} from ${p.review_count} reviews · ${p.available_quantity} available</p></article>`).join('') || '<p>No products found.</p>';
    renderPagination();
  } catch (error) { $('status').textContent = error.message; } finally { $('run').disabled = false; }
}
function renderPagination() {
  if (!lastResult || lastResult.data.length === 0) { $('pagination').innerHTML = ''; return; }
  const pageSizeInput = Number($('pageSize').value);
  const pageSize = Number.isInteger(pageSizeInput) && pageSizeInput >= 1 && pageSizeInput <= 100 ? pageSizeInput : 20;
  const pagination = lastResult.pagination || {};
  const hasPrevious = pagination.hasPrevious ?? currentPage > 1;
  const hasNext = pagination.hasNext ?? lastResult.data.length === pageSize;
  const pageLabel = pagination.totalPages ? `Page ${currentPage} of ${pagination.totalPages}` : `Page ${currentPage}`;
  let html = `<nav><button id="prev-page" ${!hasPrevious ? 'disabled' : ''}>← Previous</button>`;
  html += `<span>${pageLabel}</span>`;
  html += `<button id="next-page" ${!hasNext ? 'disabled' : ''}>Next →</button></nav>`;
  $('pagination').innerHTML = html;
  if (currentPage > 1) $('prev-page').addEventListener('click', () => run(currentPage - 1));
  if (hasNext) $('next-page').addEventListener('click', () => run(currentPage + 1));
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char])); }

// Show the active cache configuration so the TTL and invalidation settings are
// visible while demonstrating the cache.
async function loadCacheStatus() { try { const response = await fetch('/api/cache/status'); const status = await response.json(); if (!response.ok) throw new Error(status.message || 'Request failed'); const automatic = status.automaticInvalidation?.enabled && status.automaticInvalidation?.intervalMs ? `every ${Math.round(status.automaticInvalidation.intervalMs / 1000)}s` : 'disabled'; $('cache-status').innerHTML = `Cache <strong>${status.cacheEnabled ? 'enabled' : 'disabled'}</strong> · TTL <strong>${status.ttlSeconds}s</strong> · key prefix <strong>${escapeHtml(status.keyPrefix)}</strong> · automatic invalidation <strong>${automatic}</strong>`; } catch (error) { $('cache-status').textContent = `Cache status unavailable: ${error.message}`; } }

// Invalidate every cached entry. The next query therefore reads PostgreSQL and
// repopulates the cache, which demonstrates the miss path on demand.
async function invalidate() { $('invalidate').disabled = true; $('status').textContent = 'Invalidating cache…'; try { const response = await fetch('/api/cache/invalidate', { method: 'POST' }); const result = await response.json(); if (!response.ok) throw new Error(result.message || 'Invalidation failed'); $('status').innerHTML = `<strong>Cache invalidated</strong> · generation ${result.generation} · ${result.durationMs.toFixed(2)} ms · next query will read PostgreSQL`; } catch (error) { $('status').textContent = error.message; } finally { $('invalidate').disabled = false; } }
// Event listeners receive a PointerEvent, but run() expects a numeric page.
// Start a fresh query at page one instead of passing the event as the page.
$('run').addEventListener('click', () => run(1)); $('query').addEventListener('keydown', (event) => { if (event.key === 'Enter') run(1); }); $('invalidate').addEventListener('click', invalidate); loadCacheStatus(); run(1);
