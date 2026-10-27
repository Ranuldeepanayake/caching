// Structured logging is shared by every module so container logs remain searchable.
// Pino emits JSON with an ISO timestamp; child loggers add a stable module name
// so operators can filter one subsystem without parsing free-form messages.
import pino from 'pino';
import { config } from './config.js';

/** JSON logs include timestamp, module and context for container troubleshooting. */
export const logger = pino({ level: config.logLevel, base: { service: 'cache-demo' }, timestamp: pino.stdTimeFunctions.isoTime });

/** Create a logger that identifies the source module in every record. */
export const childLogger = (module) => logger.child({ module });
