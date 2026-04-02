/**
 * Database migration runner
 * Manages schema versioning and migration execution across all adapter types
 */

import {
  Migration,
  MigrationContext,
  MigrationRecord,
  MigrationStatus,
  AdapterType,
} from './types';
import { migrations } from './index';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

/**
 * Interface for the raw database operations the runner needs.
 * Each adapter provides an implementation of this.
 */
export interface MigrationExecutor {
  adapterType: AdapterType;
  /** Execute raw SQL (SQL adapters) */
  executeSql?(sql: string, params?: unknown[]): Promise<void>;
  /** Execute raw SQL and return rows (SQL adapters) */
  querySql?<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Get MongoDB Db instance (MongoDB adapter) */
  getMongoDb?(): import('mongodb').Db;
  /** Check if a table/collection exists */
  tableExists(name: string): Promise<boolean>;
}

/**
 * Runs database migrations in order, tracking which have been applied.
 */
export class MigrationRunner {
  private executor: MigrationExecutor;

  constructor(executor: MigrationExecutor) {
    this.executor = executor;
  }

  /**
   * Run all pending migrations
   */
  async run(): Promise<void> {
    await this.ensureMigrationsTable();
    await this.handleBaseline();

    const applied = await this.getAppliedVersions();
    const pending = migrations.filter((m) => !applied.has(m.version));

    if (pending.length === 0) {
      logger.debug('No pending migrations');
      return;
    }

    // Sort by version
    pending.sort((a, b) => this.compareVersions(a.version, b.version));

    for (const migration of pending) {
      logger.info(`Running migration ${migration.version}: ${migration.description}`);
      try {
        const ctx = this.createContext();
        await migration.up(ctx);
        await this.recordMigration(migration);
        await this.updateSchemaVersion(migration.version);
        logger.info(`Migration ${migration.version} applied successfully`);
      } catch (error) {
        logger.error(`Migration ${migration.version} failed:`, error);
        throw error;
      }
    }
  }

  /**
   * Rollback migrations down to (but not including) the target version.
   * If no target is specified, rolls back only the last migration.
   */
  async rollback(targetVersion?: string): Promise<void> {
    const applied = await this.getAppliedMigrations();

    if (applied.length === 0) {
      logger.info('No migrations to rollback');
      return;
    }

    // Sort applied in reverse order
    applied.sort((a, b) => this.compareVersions(b.version, a.version));

    for (const record of applied) {
      if (targetVersion && this.compareVersions(record.version, targetVersion) <= 0) {
        break;
      }

      const migration = migrations.find((m) => m.version === record.version);
      if (!migration) {
        throw new Error(`Migration ${record.version} not found in registry`);
      }

      logger.info(`Rolling back migration ${migration.version}: ${migration.description}`);
      const ctx = this.createContext();
      await migration.down(ctx);
      await this.removeMigrationRecord(record.version);

      // Only rollback one if no target specified
      if (!targetVersion) break;
    }
  }

  /**
   * Get status of all migrations
   */
  async status(): Promise<MigrationStatus[]> {
    const applied = await this.getAppliedMigrations();
    const appliedMap = new Map(applied.map((r) => [r.version, r]));

    return migrations.map((m) => {
      const record = appliedMap.get(m.version);
      return {
        version: m.version,
        description: m.description,
        applied: !!record,
        applied_at: record?.applied_at || null,
      };
    });
  }

  private createContext(): MigrationContext {
    return {
      adapterType: this.executor.adapterType,
      executeSql: this.executor.executeSql?.bind(this.executor),
      getMongoDb: this.executor.getMongoDb?.bind(this.executor),
    };
  }

  private async ensureMigrationsTable(): Promise<void> {
    const exists = await this.executor.tableExists('schema_migrations');
    if (exists) return;

    if (this.executor.adapterType === 'mongodb') {
      // MongoDB: create collection with no special schema
      const db = this.executor.getMongoDb!();
      await db.createCollection('schema_migrations');
    } else {
      await this.executor.executeSql!(this.getMigrationsTableDDL(this.executor.adapterType));
    }
  }

  private getMigrationsTableDDL(adapterType: AdapterType): string {
    switch (adapterType) {
      case 'sqlite':
        return `CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          description TEXT,
          applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`;
      case 'mysql':
        return `CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(20) PRIMARY KEY,
          description VARCHAR(255),
          applied_at DATETIME DEFAULT NOW()
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
      case 'mssql':
        return `IF OBJECT_ID('schema_migrations', 'U') IS NULL
          CREATE TABLE schema_migrations (
            version NVARCHAR(20) PRIMARY KEY,
            description NVARCHAR(255),
            applied_at DATETIME2 DEFAULT GETUTCDATE()
          )`;
      default:
        throw new Error(`Unsupported adapter type for DDL: ${adapterType}`);
    }
  }

  /**
   * Detect pre-migration databases and mark baseline as applied.
   * If system_state exists with schema_version but schema_migrations is empty,
   * this is an existing database that predates the migration system.
   */
  private async handleBaseline(): Promise<void> {
    const applied = await this.getAppliedVersions();
    if (applied.size > 0) return; // Already has migration records

    if (this.executor.adapterType === 'mongodb') {
      const db = this.executor.getMongoDb!();
      const doc = await db.collection('system_state').findOne({ key: 'schema_version' });
      if (doc?.value) {
        await this.baselineTo(doc.value as string);
      }
    } else {
      // Check if system_state table exists
      const hasSystemState = await this.executor.tableExists('system_state');
      if (!hasSystemState) return;

      const rows = await this.executor.querySql!<{ value: string }>(
        "SELECT value FROM system_state WHERE key = 'schema_version'"
      );
      if (rows.length > 0 && rows[0].value) {
        await this.baselineTo(rows[0].value);
      }
    }
  }

  /**
   * Mark all migrations up to and including the given version as already applied
   */
  private async baselineTo(version: string): Promise<void> {
    logger.info(`Baseline detected: schema version ${version}. Marking migrations as applied.`);

    const toBaseline = migrations.filter((m) => this.compareVersions(m.version, version) <= 0);

    for (const migration of toBaseline) {
      await this.recordMigration(migration);
    }
  }

  private async getAppliedVersions(): Promise<Set<string>> {
    const records = await this.getAppliedMigrations();
    return new Set(records.map((r) => r.version));
  }

  private async getAppliedMigrations(): Promise<MigrationRecord[]> {
    if (this.executor.adapterType === 'mongodb') {
      const db = this.executor.getMongoDb!();
      const docs = await db.collection('schema_migrations').find().toArray();
      return docs.map((d: Record<string, unknown>) => ({
        version: d.version as string,
        description: d.description as string,
        applied_at: d.applied_at as string,
      }));
    }

    return this.executor.querySql!<MigrationRecord>(
      'SELECT version, description, applied_at FROM schema_migrations ORDER BY version'
    );
  }

  private async recordMigration(migration: Migration): Promise<void> {
    if (this.executor.adapterType === 'mongodb') {
      const db = this.executor.getMongoDb!();
      await db.collection('schema_migrations').insertOne({
        version: migration.version,
        description: migration.description,
        applied_at: new Date().toISOString(),
      });
    } else if (this.executor.adapterType === 'mssql') {
      await this.executor.executeSql!(
        'INSERT INTO schema_migrations (version, description) VALUES (@p1, @p2)',
        [migration.version, migration.description]
      );
    } else {
      await this.executor.executeSql!(
        'INSERT INTO schema_migrations (version, description) VALUES (?, ?)',
        [migration.version, migration.description]
      );
    }
  }

  private async removeMigrationRecord(version: string): Promise<void> {
    if (this.executor.adapterType === 'mongodb') {
      const db = this.executor.getMongoDb!();
      await db.collection('schema_migrations').deleteOne({ version });
    } else if (this.executor.adapterType === 'mssql') {
      await this.executor.executeSql!('DELETE FROM schema_migrations WHERE version = @p1', [
        version,
      ]);
    } else {
      await this.executor.executeSql!('DELETE FROM schema_migrations WHERE version = ?', [version]);
    }
  }

  private async updateSchemaVersion(version: string): Promise<void> {
    if (this.executor.adapterType === 'mongodb') {
      const db = this.executor.getMongoDb!();
      await db
        .collection('system_state')
        .updateOne(
          { key: 'schema_version' },
          { $set: { value: version, updated_at: new Date().toISOString() } },
          { upsert: true }
        );
    } else if (this.executor.adapterType === 'mssql') {
      await this.executor.executeSql!(
        `UPDATE system_state SET value = @p1, updated_at = GETUTCDATE() WHERE [key] = 'schema_version'`,
        [version]
      );
    } else {
      await this.executor.executeSql!(
        `UPDATE system_state SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = 'schema_version'`,
        [version]
      );
    }
  }

  /**
   * Compare two semver version strings
   * Returns negative if a < b, 0 if equal, positive if a > b
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }
}
