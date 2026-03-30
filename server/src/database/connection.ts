/**
 * Database connection manager
 * Provides a singleton database adapter instance
 */

import { DatabaseAdapter } from './adapters/base.adapter';
import { SQLiteAdapter } from './adapters/sqlite.adapter';
import { MySQLAdapter } from './adapters/mysql.adapter';
import { MSSQLAdapter } from './adapters/mssql.adapter';
import { MongoDBAdapter } from './adapters/mongodb.adapter';
import { config, DatabaseType } from '../config/config';
import { getLogger } from '../utils/logger';

const logger = getLogger();

let adapterInstance: DatabaseAdapter | null = null;

/**
 * Gets the database adapter instance
 * Creates and connects the adapter if not already initialized
 */
export async function getDatabase(): Promise<DatabaseAdapter> {
  if (!adapterInstance) {
    adapterInstance = createAdapter();
    await adapterInstance.connect();
  }
  return adapterInstance;
}

/**
 * Creates a database adapter based on configuration
 */
function createAdapter(): DatabaseAdapter {
  switch (config.database.type) {
    case DatabaseType.SQLITE:
      if (!config.database.sqlite) {
        throw new Error('SQLite configuration is missing');
      }
      return new SQLiteAdapter(config.database.sqlite.path);

    case DatabaseType.MYSQL:
      if (!config.database.mysql) {
        throw new Error('MySQL configuration is missing');
      }
      return new MySQLAdapter(config.database.mysql);

    case DatabaseType.MSSQL:
      if (!config.database.mssql) {
        throw new Error('MSSQL configuration is missing');
      }
      return new MSSQLAdapter(config.database.mssql);

    case DatabaseType.MONGODB:
      if (!config.database.mongodb) {
        throw new Error('MongoDB configuration is missing');
      }
      return new MongoDBAdapter(config.database.mongodb.uri);

    default:
      throw new Error(`Unsupported database type: ${String(config.database.type)}`);
  }
}

/**
 * Closes the database connection
 */
export async function closeDatabase(): Promise<void> {
  if (adapterInstance) {
    await adapterInstance.disconnect();
    adapterInstance = null;
    logger.info('Database connection closed');
  }
}

/**
 * Checks if database is connected
 */
export function isDatabaseConnected(): boolean {
  return adapterInstance !== null && adapterInstance.isConnected();
}

export default getDatabase;
