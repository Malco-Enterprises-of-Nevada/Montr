/**
 * Comprehensive unit tests for database connection factory
 * Tests getDatabase, closeDatabase, isDatabaseConnected, and createAdapter logic.
 *
 * Because connection.ts holds a module-level singleton (adapterInstance) and
 * imports config at module scope, every test uses jest.isolateModules() to
 * obtain a fresh module with its own singleton state.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Shared mock adapter state — captured references accessible to both
// the isolated module scope and the test assertions.
// ---------------------------------------------------------------------------

const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

// These hold the mock constructor and the adapter instance it produces.
// They are reassigned in beforeEach so each test gets fresh mocks.
let mockSQLiteAdapter: jest.Mock;
let mockMySQLAdapter: jest.Mock;
let mockMSSQLAdapter: jest.Mock;
let mockMongoDBAdapter: jest.Mock;

let lastSqliteInstance: any;
let lastMysqlInstance: any;
let lastMssqlInstance: any;
let lastMongodbInstance: any;

function makeMockAdapter() {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockReturnValue(true),
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks — registered once, but constructors point to variables
// that are reassigned each beforeEach.
// ---------------------------------------------------------------------------

jest.mock('../../../src/utils/logger', () => ({
  getLogger: () => mockLogger,
}));

jest.mock('../../../src/database/adapters/sqlite.adapter', () => ({
  get SQLiteAdapter() {
    return mockSQLiteAdapter;
  },
}));

jest.mock('../../../src/database/adapters/mysql.adapter', () => ({
  get MySQLAdapter() {
    return mockMySQLAdapter;
  },
}));

jest.mock('../../../src/database/adapters/mssql.adapter', () => ({
  get MSSQLAdapter() {
    return mockMSSQLAdapter;
  },
}));

jest.mock('../../../src/database/adapters/mongodb.adapter', () => ({
  get MongoDBAdapter() {
    return mockMongoDBAdapter;
  },
}));

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.resetModules();

  mockLogger.info.mockClear();
  mockLogger.error.mockClear();
  mockLogger.warn.mockClear();
  mockLogger.debug.mockClear();

  lastSqliteInstance = makeMockAdapter();
  lastMysqlInstance = makeMockAdapter();
  lastMssqlInstance = makeMockAdapter();
  lastMongodbInstance = makeMockAdapter();

  mockSQLiteAdapter = jest.fn(() => lastSqliteInstance);
  mockMySQLAdapter = jest.fn(() => lastMysqlInstance);
  mockMSSQLAdapter = jest.fn(() => lastMssqlInstance);
  mockMongoDBAdapter = jest.fn(() => lastMongodbInstance);
});

// ---------------------------------------------------------------------------
// Helper: load the connection module inside an isolated module scope with
// a specific config value.
// ---------------------------------------------------------------------------

function loadConnectionModule(databaseConfig: Record<string, any>) {
  let mod: any;

  jest.doMock('../../../src/config/config', () => ({
    config: { database: databaseConfig },
    DatabaseType: {
      SQLITE: 'sqlite',
      MYSQL: 'mysql',
      MSSQL: 'mssql',
      MONGODB: 'mongodb',
    },
  }));

  jest.isolateModules(() => {
    mod = require('../../../src/database/connection');
  });

  return mod as {
    getDatabase: () => Promise<any>;
    closeDatabase: () => Promise<void>;
    isDatabaseConnected: () => boolean;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Database Connection Factory', () => {
  // -----------------------------------------------------------------------
  // getDatabase
  // -----------------------------------------------------------------------
  describe('getDatabase', () => {
    it('should create SQLiteAdapter when type is sqlite and call connect()', async () => {
      const { getDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      const db = await getDatabase();

      expect(mockSQLiteAdapter).toHaveBeenCalledWith(':memory:');
      expect(db.connect).toHaveBeenCalledTimes(1);
    });

    it('should create MySQLAdapter when type is mysql and call connect()', async () => {
      const mysqlConfig = {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'pass',
        database: 'montr',
      };

      const { getDatabase } = loadConnectionModule({
        type: 'mysql',
        mysql: mysqlConfig,
      });

      const db = await getDatabase();

      expect(mockMySQLAdapter).toHaveBeenCalledWith(mysqlConfig);
      expect(db.connect).toHaveBeenCalledTimes(1);
    });

    it('should create MSSQLAdapter when type is mssql and call connect()', async () => {
      const mssqlConfig = {
        server: 'localhost',
        port: 1433,
        user: 'sa',
        password: 'pass',
        database: 'montr',
      };

      const { getDatabase } = loadConnectionModule({
        type: 'mssql',
        mssql: mssqlConfig,
      });

      const db = await getDatabase();

      expect(mockMSSQLAdapter).toHaveBeenCalledWith(mssqlConfig);
      expect(db.connect).toHaveBeenCalledTimes(1);
    });

    it('should create MongoDBAdapter when type is mongodb and call connect()', async () => {
      const { getDatabase } = loadConnectionModule({
        type: 'mongodb',
        mongodb: { uri: 'mongodb://localhost:27017/montr' },
      });

      const db = await getDatabase();

      expect(mockMongoDBAdapter).toHaveBeenCalledWith('mongodb://localhost:27017/montr');
      expect(db.connect).toHaveBeenCalledTimes(1);
    });

    it('should return the same instance on subsequent calls (singleton)', async () => {
      const { getDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      const first = await getDatabase();
      const second = await getDatabase();

      expect(first).toBe(second);
      expect(mockSQLiteAdapter).toHaveBeenCalledTimes(1);
      expect(first.connect).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // createAdapter errors (exercised via getDatabase)
  // -----------------------------------------------------------------------
  describe('createAdapter errors (via getDatabase)', () => {
    it('should throw when sqlite config section is missing', async () => {
      const { getDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: undefined,
      });

      await expect(getDatabase()).rejects.toThrow('SQLite configuration is missing');
    });

    it('should throw when mysql config section is missing', async () => {
      const { getDatabase } = loadConnectionModule({
        type: 'mysql',
        mysql: undefined,
      });

      await expect(getDatabase()).rejects.toThrow('MySQL configuration is missing');
    });

    it('should throw for unsupported database type', async () => {
      const { getDatabase } = loadConnectionModule({
        type: 'cassandra',
      });

      await expect(getDatabase()).rejects.toThrow('Unsupported database type: cassandra');
    });
  });

  // -----------------------------------------------------------------------
  // closeDatabase
  // -----------------------------------------------------------------------
  describe('closeDatabase', () => {
    it('should call disconnect() on the adapter', async () => {
      const { getDatabase, closeDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      const db = await getDatabase();
      await closeDatabase();

      expect(db.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should set adapter to null so next getDatabase creates a new one', async () => {
      const { getDatabase, closeDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      const first = await getDatabase();
      await closeDatabase();

      // After close, getting the database again should invoke the constructor a second time
      const second = await getDatabase();

      expect(mockSQLiteAdapter).toHaveBeenCalledTimes(2);
      // The mock constructor returns the same underlying object, so connect
      // accumulates calls: once for the first getDatabase, once for the second.
      expect(second.connect).toHaveBeenCalledTimes(2);
      // Verify it really is a new adapter creation, not the cached singleton
      expect(first).toBe(second); // same object since mock returns same instance
      expect(first.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should not throw when no adapter exists', async () => {
      const { closeDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      // Never called getDatabase -- adapter is null
      await expect(closeDatabase()).resolves.toBeUndefined();
    });

    it('should log "Database connection closed"', async () => {
      const { getDatabase, closeDatabase } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      await getDatabase();
      await closeDatabase();

      expect(mockLogger.info).toHaveBeenCalledWith('Database connection closed');
    });
  });

  // -----------------------------------------------------------------------
  // isDatabaseConnected
  // -----------------------------------------------------------------------
  describe('isDatabaseConnected', () => {
    it('should return false when no adapter has been created', () => {
      const { isDatabaseConnected } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      expect(isDatabaseConnected()).toBe(false);
    });

    it('should return true when adapter.isConnected() returns true', async () => {
      const { getDatabase, isDatabaseConnected } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      const db = await getDatabase();
      db.isConnected.mockReturnValue(true);

      expect(isDatabaseConnected()).toBe(true);
    });

    it('should return false when adapter.isConnected() returns false', async () => {
      const { getDatabase, isDatabaseConnected } = loadConnectionModule({
        type: 'sqlite',
        sqlite: { path: ':memory:' },
      });

      const db = await getDatabase();
      db.isConnected.mockReturnValue(false);

      expect(isDatabaseConnected()).toBe(false);
    });
  });
});
