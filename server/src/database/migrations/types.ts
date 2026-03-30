/**
 * Database migration types
 */

export type AdapterType = 'sqlite' | 'mysql' | 'mssql' | 'mongodb';

/**
 * Context provided to migration up/down functions
 */
export interface MigrationContext {
  /** Execute raw SQL (available for SQL-based adapters) */
  executeSql?(sql: string, params?: unknown[]): Promise<void>;
  /** Get MongoDB database instance (available for MongoDB adapter) */
  getMongoDb?(): import('mongodb').Db;
  /** The type of database adapter being migrated */
  adapterType: AdapterType;
}

/**
 * A single database migration
 */
export interface Migration {
  /** Semver version string (e.g. '1.0.0') */
  version: string;
  /** Human-readable description */
  description: string;
  /** Apply the migration */
  up(ctx: MigrationContext): Promise<void>;
  /** Reverse the migration */
  down(ctx: MigrationContext): Promise<void>;
}

/**
 * Record of an applied migration
 */
export interface MigrationRecord {
  version: string;
  description: string;
  applied_at: string;
}

/**
 * Status of a migration (applied or pending)
 */
export interface MigrationStatus {
  version: string;
  description: string;
  applied: boolean;
  applied_at: string | null;
}
