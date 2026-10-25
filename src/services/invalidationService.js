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

export function createInvalidationService(pool, redis, productService) {
  // Last successfully computed fingerprint. It is kept in memory: the value is
  // only used to detect a change between two consecutive checks, and a restart
  // legitimately re-establishes the baseline.
  let lastFingerprint = null;
  let timer = null;
  let running = false;

  /**
   * Compare the current data fingerprint with the previous one and invalidate
   * the cache when something changed.
   * Returns a summary describing what happened, for logging and for the API.
   */
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

    /**
     * Force an invalidation regardless of whether the data changed.
     * This backs the manual invalidation button and the API endpoint.
     */
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

    /** Start the periodic change check. */
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

    /** Stop the periodic change check. */
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    /** Expose the current baseline fingerprint, for diagnostics. */
    getFingerprint() {
      return lastFingerprint;
    }
  };
}
