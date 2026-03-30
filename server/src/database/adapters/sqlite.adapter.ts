/**
 * SQLite database adapter implementation
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SqlBaseAdapter, ExecuteResult } from './sql-base.adapter';
import { MigrationRunner, MigrationExecutor } from '../migrations/runner';
import { AdapterType } from '../migrations/types';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

export class SQLiteAdapter extends SqlBaseAdapter {
  private db: Database.Database | null = null;

  private dbPath: string;

  constructor(dbPath: string) {
    super();
    this.dbPath = dbPath;
  }

  async connect(): Promise<void> {
    try {
      // Ensure database directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Open database connection
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      // Run migrations
      const runner = new MigrationRunner(this.getMigrationExecutor());
      await runner.run();

      logger.info(`SQLite database connected: ${this.dbPath}`);
    } catch (error) {
      logger.error('Failed to connect to SQLite database:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('SQLite database disconnected');
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  protected currentTimestampFn(): string {
    return 'CURRENT_TIMESTAMP';
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    return this.db;
  }

  // ── Raw database access methods ──────────────────────────────────────────

  async rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const db = this.getDb();
    if (params && params.length > 0) {
      return db.prepare(sql).all(...params) as T[];
    }
    return db.prepare(sql).all() as T[];
  }

  async rawQueryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const db = this.getDb();
    let result: T | undefined;
    if (params && params.length > 0) {
      result = db.prepare(sql).get(...params) as T | undefined;
    } else {
      result = db.prepare(sql).get() as T | undefined;
    }
    return result || null;
  }

  async rawExecute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const db = this.getDb();
    let result: Database.RunResult;
    if (params && params.length > 0) {
      result = db.prepare(sql).run(...params);
    } else {
      result = db.prepare(sql).run();
    }
    return {
      lastInsertId: Number(result.lastInsertRowid),
      affectedRows: result.changes,
    };
  }

  async rawTransaction(fn: () => Promise<void>): Promise<void> {
    const db = this.getDb();
    // better-sqlite3 transactions are synchronous, but we wrap in async
    // to support the interface. We use a manual BEGIN/COMMIT pattern.
    db.exec('BEGIN');
    try {
      await fn();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  getMigrationExecutor(): MigrationExecutor {
    const self = this;
    return {
      adapterType: 'sqlite' as AdapterType,
      async executeSql(sql: string, params?: unknown[]): Promise<void> {
        const db = self.getDb();
        if (params && params.length > 0) {
          db.prepare(sql).run(...params);
        } else {
          db.exec(sql);
        }
      },
      async querySql<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const db = self.getDb();
        if (params && params.length > 0) {
          return db.prepare(sql).all(...params) as T[];
        }
        return db.prepare(sql).all() as T[];
      },
      async tableExists(name: string): Promise<boolean> {
        const db = self.getDb();
        const row = db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        ).get(name);
        return !!row;
      },
    };
  }
}
