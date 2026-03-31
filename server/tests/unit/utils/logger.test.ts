import type winston from 'winston';

describe('Logger Module', () => {
  let getLogger: () => winston.Logger;
  let initLogger: (config: { level: string; logFile?: string }) => void;

  beforeEach(() => {
    jest.resetModules();
  });

  describe('getLogger', () => {
    it('should return a logger instance without prior init (creates default)', () => {
      ({ getLogger } = require('../../../src/utils/logger'));

      const logger = getLogger();

      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
    });

    it('should return the same instance on repeated calls (singleton)', () => {
      ({ getLogger } = require('../../../src/utils/logger'));

      const logger1 = getLogger();
      const logger2 = getLogger();

      expect(logger1).toBe(logger2);
    });

    it('should have info, error, warn, and debug methods', () => {
      ({ getLogger } = require('../../../src/utils/logger'));

      const logger = getLogger();

      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
    });

    it('should default to info level', () => {
      ({ getLogger } = require('../../../src/utils/logger'));

      const logger = getLogger();

      expect(logger.level).toBe('info');
    });
  });

  describe('initLogger', () => {
    it('should initialize with the specified level', () => {
      ({ initLogger, getLogger } = require('../../../src/utils/logger'));

      initLogger({ level: 'debug' });
      const logger = getLogger();

      expect(logger.level).toBe('debug');
    });

    it('should return logger at the new level after init', () => {
      ({ initLogger, getLogger } = require('../../../src/utils/logger'));

      // First call creates default with 'info'
      const defaultLogger = getLogger();
      expect(defaultLogger.level).toBe('info');

      // Init with 'warn'
      initLogger({ level: 'warn' });
      const updatedLogger = getLogger();

      expect(updatedLogger.level).toBe('warn');
    });

    it('should create a file transport when logFile is provided', () => {
      jest.doMock('fs', () => ({
        ...jest.requireActual('fs'),
        existsSync: jest.fn().mockReturnValue(true),
        mkdirSync: jest.fn(),
      }));

      ({ initLogger, getLogger } = require('../../../src/utils/logger'));

      initLogger({ level: 'info', logFile: '/tmp/montr-test-logger/test.log' });
      const logger = getLogger();

      // Winston adds exception/rejection handler transports alongside our
      // explicit transports.  Without a logFile there are N transports;
      // with a logFile the File transport is added, so the count increases.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasFileTransport = logger.transports.some(
        (t: any) => typeof t.filename === 'string',
      );
      expect(hasFileTransport).toBe(true);
    });

    it('should only have console transport when logFile is not provided', () => {
      ({ initLogger, getLogger } = require('../../../src/utils/logger'));

      initLogger({ level: 'info' });
      const logger = getLogger();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasFileTransport = logger.transports.some(
        (t: any) => typeof t.filename === 'string',
      );
      expect(hasFileTransport).toBe(false);
    });
  });
});
