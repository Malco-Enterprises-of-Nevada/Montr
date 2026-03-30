/**
 * Jest config for database adapter tests.
 * Does NOT mock better-sqlite3 — these tests use real database connections.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/unit/database'],
  testMatch: [
    '**/sqlite.conformance.test.ts',
    '**/migration-runner.test.ts',
    '**/mysql.adapter.test.ts',
    '**/mssql.adapter.test.ts',
    '**/mongodb.adapter.test.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      diagnostics: {
        ignoreCodes: [6133, 18046, 2322, 2352, 2540]
      }
    }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  testTimeout: 30000,
  clearMocks: true,
  // NO moduleNameMapper — use real better-sqlite3
};
