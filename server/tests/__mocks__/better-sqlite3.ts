/**
 * Manual mock for better-sqlite3
 * Used for testing when the native module is not available
 */

const mockDatabase = {
  prepare: jest.fn(() => ({
    run: jest.fn(),
    get: jest.fn(),
    all: jest.fn(() => []),
  })),
  exec: jest.fn(),
  pragma: jest.fn(),
  close: jest.fn(),
  transaction: jest.fn((fn) => fn),
};

const Database = jest.fn(() => mockDatabase);

export default Database;
