// Shared retry helper for transient connection failures. Backoff prevents a failed
// dependency from creating a tight reconnect loop while the service is unavailable.
import { config } from '../config.js';
import { childLogger } from '../logger.js';

const log = childLogger('connection-retry');

/**
 * Run a dependency operation with bounded exponential backoff.
 * @param {() => Promise<unknown>} operation - Operation that may fail transiently.
 * @param {string} dependency - Safe dependency label used in diagnostic logs.
 * @returns {Promise<unknown>} The first successful operation result.
 * @throws The final error after all configured attempts fail.
 */
export async function withConnectionRetry(operation, dependency) {
  let lastError;
  for (let attempt = 1; attempt <= config.connectionRetryAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === config.connectionRetryAttempts) break;
      const delayMs = Math.min(config.connectionRetryBaseDelayMs * (2 ** (attempt - 1)), 30000);
      log.warn({ dependency, attempt, nextAttemptInMs: delayMs, err: error }, 'connection attempt failed; retrying');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  log.error({ dependency, attempts: config.connectionRetryAttempts, err: lastError }, 'connection retries exhausted');
  throw lastError;
}
