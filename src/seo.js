// Dynamic search-engine metadata for the single-page application. The canonical
// origin is configurable for deployments behind proxies or custom domains.
import { config } from './config.js';

/**
 * Resolve a canonical public origin from configuration or proxy data.
 * @param {import('express').Request} request - Current HTTP request.
 * @returns {string} Origin without a trailing slash.
 */
export function getPublicOrigin(request) {
  const configuredOrigin = config.publicBaseUrl;
  if (configuredOrigin) return configuredOrigin.replace(/\/$/, '');
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProtocol || request.protocol || 'http';
  return `${protocol}://${request.get('host')}`.replace(/\/$/, '');
}

/** Build the sitemap from public application routes only. */
export function createSitemapXml(origin) {
  const escapedOrigin = origin.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${escapedOrigin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`;
}

/** Express handlers keep robots and sitemap content fresh without build-time files. */
export function createSeoRouter() {
  return (request, response) => {
    const origin = getPublicOrigin(request);
    if (request.path === '/sitemap.xml') {
      response.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(createSitemapXml(origin));
      return;
    }
    response.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(`User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${origin}/sitemap.xml\n`);
  };
}
