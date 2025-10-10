import winston from 'winston';
import path from 'path';
import fs from 'fs';

/**
 * Logger configuration interface
 */
interface LoggerConfig {
  level: string;
  logFile?: string;
}

/**
 * Creates and configures a Winston logger instance
 * @param config - Logger configuration object
 * @returns Configured Winston logger
 */
function createLogger(config: LoggerConfig): winston.Logger {
  const { level, logFile } = config;

  // Define log format
  const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level: logLevel, message, stack }) => {
      const ts = String(timestamp);
      const lvl = String(logLevel).toUpperCase();
      const msg = String(message);
      if (stack) {
        return `${ts} [${lvl}]: ${msg}\n${String(stack)}`;
      }
      return `${ts} [${lvl}]: ${msg}`;
    })
  );

  // Console format with colors
  const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level: logLevel, message, stack }) => {
      const ts = String(timestamp);
      const lvl = String(logLevel);
      const msg = String(message);
      if (stack) {
        return `${ts} [${lvl}]: ${msg}\n${String(stack)}`;
      }
      return `${ts} [${lvl}]: ${msg}`;
    })
  );

  // Configure transports
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ];

  // Add file transport if log file is specified
  if (logFile) {
    // Ensure log directory exists
    const logDir = path.dirname(logFile);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    transports.push(
      new winston.transports.File({
        filename: logFile,
        format: logFormat,
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 5,
        tailable: true,
      })
    );
  }

  return winston.createLogger({
    level,
    format: logFormat,
    transports,
    exceptionHandlers: [
      new winston.transports.Console({
        format: consoleFormat,
      }),
    ],
    rejectionHandlers: [
      new winston.transports.Console({
        format: consoleFormat,
      }),
    ],
  });
}

// Export a singleton logger instance that will be configured later
let logger: winston.Logger;

/**
 * Initializes the logger with the given configuration
 * @param config - Logger configuration
 */
export function initLogger(config: LoggerConfig): void {
  logger = createLogger(config);
}

/**
 * Gets the logger instance
 * @returns Winston logger instance
 */
export function getLogger(): winston.Logger {
  if (!logger) {
    // Return a default logger if not initialized
    logger = createLogger({ level: 'info' });
  }
  return logger;
}

export default getLogger;
