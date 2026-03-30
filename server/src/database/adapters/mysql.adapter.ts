/**
 * MySQL database adapter implementation
 * Uses mysql2/promise with connection pooling
 */

import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { SqlBaseAdapter, ExecuteResult } from './sql-base.adapter';
import { MigrationRunner, MigrationExecutor } from '../migrations/runner';
import { AdapterType } from '../migrations/types';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

export interface MySQLConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class MySQLAdapter extends SqlBaseAdapter {
  private pool: Pool | null = null;

  private config: MySQLConfig;

  constructor(config: MySQLConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        multipleStatements: false,
      });

      // Verify connection
      const conn = await this.pool.getConnection();
      conn.release();

      // Run migrations
      const runner = new MigrationRunner(this.getMigrationExecutor());
      await runner.run();

      logger.info(`MySQL database connected: ${this.config.host}:${this.config.port}/${this.config.database}`);
    } catch (error) {
      logger.error('Failed to connect to MySQL database:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info('MySQL database disconnected');
    }
  }

  isConnected(): boolean {
    return this.pool !== null;
  }

  protected currentTimestampFn(): string {
    return 'NOW()';
  }

  private getPool(): Pool {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool;
  }

  // ── Raw database access methods ──────────────────────────────────────────

  async rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const pool = this.getPool();
    const [rows] = await pool.execute<RowDataPacket[]>(sql, params as (string | number | null)[] || []);
    return rows as T[];
  }

  async rawQueryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.rawQuery<T>(sql, params);
    return rows[0] || null;
  }

  async rawExecute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const pool = this.getPool();
    const [result] = await pool.execute<ResultSetHeader>(sql, params as (string | number | null)[] || []);
    return {
      lastInsertId: result.insertId,
      affectedRows: result.affectedRows,
    };
  }

  async rawTransaction(fn: () => Promise<void>): Promise<void> {
    const pool = this.getPool();
    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await fn();
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  getMigrationExecutor(): MigrationExecutor {
    const self = this;
    return {
      adapterType: 'mysql' as AdapterType,
      async executeSql(sql: string, params?: unknown[]): Promise<void> {
        const pool = self.getPool();
        await pool.execute(sql, params as (string | number | null)[] || []);
      },
      async querySql<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const pool = self.getPool();
        const [rows] = await pool.execute<RowDataPacket[]>(sql, params as (string | number | null)[] || []);
        return rows as T[];
      },
      async tableExists(name: string): Promise<boolean> {
        const pool = self.getPool();
        const [rows] = await pool.execute<RowDataPacket[]>(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = ? AND table_name = ?`,
          [self.config.database, name],
        );
        return rows.length > 0;
      },
    };
  }
}
