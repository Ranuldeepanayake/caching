// Structured logging is shared by every module so container logs remain searchable.
import pino from 'pino';
import { config } from './config.js';

/** JSON logs include timestamp, module and context for container troubleshooting. */
export const logger = pino({ level: config.logLevel, base: { service: 'cache-demo' }, timestamp: pino.stdTimeFunctions.isoTime });
export const childLogger = (module) => logger.child({ module });
