// Detects changes to the underlying data and invalidates the cache when they occur.
//
// Two triggers are supported:
//
//   1. Automatic: a fingerprint of the tables that feed the cached query is
//      compared on a timer. When it differs from the previous fingerprint, the
//      cache generation is bumped and the cached entries become unreachable.
//
//   2. Manual: the API exposes an endpoint that bumps the generation on
//      demand, for demonstration and for operators who want a guaranteed fresh
//      read immediately.
//
// The automatic check is deliberately conservative: a failed check is logged
// and retried on the next tick rather than being treated as a change, so a
// transient database error cannot wipe the cache.
import { config } from '../config.js';
import { childLogger } from '../logger.js';
import { computeDataFingerprint, fingerprintsDiffer } from '../repositories/dataFingerprintRepository.js';
import { bumpGeneration } from '../cacheKeys.js';
const log = childLogger('invalidation-service');

// Create invalidation service that monitors data changes and triggers cache invalidation.
// Supports both automatic polling and manual on-demand invalidation.
// @param pool - PostgreSQL connection pool (used for fingerprint queries)
// @param redis - Redis client (used for cache invalidation)
// @param productService - productService instance (called to invalidate when data changes)
export function createInvalidationService(pool, redis, productService) {
  // State tracking for the automatic invalidation loop
  let lastFingerprint = null;      // Previously computed fingerprint; null until first check
  let timer = null;                // setInterval handle for periodic checks
  let running = false;             // Prevent concurrent fingerprint computations

  // Compare current data fingerprint against baseline and invalidate cache if data changed.
  // Conservative approach: failed checks are logged and retried, never treated as changes.
  // @returns {checked, changed, generation?, reason?} - whether check completed and if data changed
  async function checkForChanges() {
    if (running) return { checked: false, changed: false, reason: 'check already in progress' };
    running = true;
    try {
      const fingerprint = await computeDataFingerprint(pool);
      if (!lastFingerprint) {
        // First check after startup establishes the baseline. Nothing is
        // invalidated, because nothing is known to have changed yet.
        lastFingerprint = fingerprint;
        log.info({ fingerprint }, 'cache invalidation baseline established');
        return { checked: true, changed: false, reason: 'baseline established' };
      }
      if (fingerprintsDiffer(lastFingerprint, fingerprint)) {
        lastFingerprint = fingerprint;
        const result = await productService.invalidate();
        log.info({ generation: result.generation, persisted: result.persisted }, 'data change detected; cache invalidated');
        return { checked: true, changed: true, generation: result.generation, persisted: result.persisted };
      }
      return { checked: true, changed: false };
    } catch (error) {
      // A failed fingerprint query must not be read as a change, otherwise a
      // database blip would invalidate the cache on every tick.
      log.error({ err: error }, 'data fingerprint check failed; cache left untouched');
      return { checked: false, changed: false, reason: 'fingerprint check failed' };
    } finally {
      running = false;
    }
  }

  return {
    checkForChanges,

    // Manually force cache invalidation immediately, regardless of data changes.
    // Used by the "Invalidate cache" UI button and POST /api/cache/invalidate endpoint.
    // Re-establishes fingerprint baseline afterward so next automatic check doesn't report stale change.
    // @param reason - string describing why invalidation was triggered (logged for diagnostics)
    // @returns {generation, persisted, durationMs, reason} - invalidation result and reason
    async invalidateNow(reason = 'manual request') {
      const result = await productService.invalidate();
      // Re-establish the baseline so the next automatic check compares against
      // the current data rather than reporting a change that was just handled.
      try {
        lastFingerprint = await computeDataFingerprint(pool);
      } catch (error) {
        log.warn({ err: error }, 'fingerprint refresh after invalidation failed');
      }
      log.info({ generation: result.generation, persisted: result.persisted, reason }, 'cache invalidated manually');
      return { ...result, reason };
    },

    // Start the automatic data-change detection loop. Called on application startup.
    // Runs checkForChanges immediately to establish baseline, then continues on the configured interval.
    start() {
      if (!config.cacheInvalidationEnabled) {
        log.info('automatic cache invalidation disabled');
        return;
      }
      if (!config.cacheInvalidationIntervalMs) {
        log.info('automatic cache invalidation interval is zero; polling disabled');
        return;
      }
      if (!pool) {
        log.warn('no database pool available; automatic cache invalidation not started');
        return;
      }
      // Check immediately so the baseline exists before the first tick, then
      // continue on the configured interval.
      checkForChanges().catch((error) => log.error({ err: error }, 'initial cache invalidation check failed'));
      timer = setInterval(() => {
        checkForChanges().catch((error) => log.error({ err: error }, 'cache invalidation check failed'));
      }, config.cacheInvalidationIntervalMs);
      // Do not keep the process alive purely for the polling timer.
      timer.unref?.();
      log.info({ intervalMs: config.cacheInvalidationIntervalMs }, 'automatic cache invalidation started');
    },

    // Stop the automatic data-change detection loop. Called on application shutdown.
    // Clears the polling timer and allows process to exit cleanly.
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    // Return the current data fingerprint for diagnostics (exposed via GET /api/cache/status).
    // Used to confirm data changed detection is working and show fingerprint in UI.
    getFingerprint() {
      return lastFingerprint;
    }
  };
}
