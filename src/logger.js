import pino from 'pino';
import config from './config.js';

const logger = pino({
  level: config.logLevel,
  base: undefined,
  timestamp: () => `,"ts":"${new Date().toISOString()}"`
});

export { logger };
