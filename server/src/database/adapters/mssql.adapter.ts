/**
 * MSSQL (SQL Server) database adapter implementation
 * Uses mssql package with connection pooling
 */

import mssql, { ConnectionPool, IResult, IRecordSet } from 'mssql';
import { SqlBaseAdapter, ExecuteResult } from './sql-base.adapter';
import { MigrationRunner, MigrationExecutor } from '../migrations/runner';
import { AdapterType } from '../migrations/types';
import { ClientStatus, CreateClientStatusInput } from '../types';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

export interface MSSQLConfig {
  server: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export class MSSQLAdapter extends SqlBaseAdapter {
  private pool: ConnectionPool | null = null;

  private config: MSSQLConfig;

  constructor(config: MSSQLConfig) {
    super();
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.pool = new mssql.ConnectionPool({
        server: this.config.server,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        options: {
          encrypt: false,
          trustServerCertificate: true,
        },
        pool: {
          max: 10,
          min: 0,
          idleTimeoutMillis: 30000,
        },
      });

      await this.pool.connect();

      // Run migrations
      const runner = new MigrationRunner(this.getMigrationExecutor());
      await runner.run();

      logger.info(
        `MSSQL database connected: ${this.config.server}:${this.config.port}/${this.config.database}`
      );
    } catch (error) {
      logger.error('Failed to connect to MSSQL database:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      logger.info('MSSQL database disconnected');
    }
  }

  isConnected(): boolean {
    return this.pool !== null && this.pool.connected;
  }

  protected currentTimestampFn(): string {
    return 'GETUTCDATE()';
  }

  /**
   * MSSQL uses @p1, @p2, etc. for named parameters
   */
  protected placeholder(index: number): string {
    return `@p${index}`;
  }

  /**
   * MSSQL uses OFFSET...FETCH NEXT for pagination (SQL Server 2012+)
   */
  protected paginationClause(paramStartIndex: number): string {
    return `OFFSET ${this.placeholder(paramStartIndex)} ROWS FETCH NEXT ${this.placeholder(paramStartIndex + 1)} ROWS ONLY`;
  }

  /** MSSQL pagination takes [offset, limit] order */
  protected paginationParams(limit: number, offset: number): unknown[] {
    return [offset, limit];
  }

  /**
   * SQL Server doesn't have a lightweight `INSERT OR IGNORE`. Wrap the
   * INSERT so a duplicate-key collision on `uniqueColumn` becomes a no-op
   * via a `WHERE NOT EXISTS` guard. Only works for single-row inserts —
   * which is all our queue-enqueue paths do.
   */
  protected upsertIgnoreSql(insertSql: string, uniqueColumn: string): string {
    // Transform: INSERT INTO tbl (cols...) VALUES (vals...)
    //   →      INSERT INTO tbl (cols...) SELECT vals... WHERE NOT EXISTS
    //                  (SELECT 1 FROM tbl WHERE uniqueColumn = {first value})
    // Caller already arranges for the first placeholder/value to be the
    // unique-column value (true for enqueueUploadCompletionJob).
    const m = insertSql.match(
      /^INSERT\s+INTO\s+(\w+)\s*\((.+?)\)\s*VALUES\s*\((.+?)\)\s*$/is
    );
    if (!m) return insertSql;
    const [, table, cols, vals] = m;
    return (
      `INSERT INTO ${table} (${cols}) ` +
      `SELECT ${vals} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM ${table} WHERE ${uniqueColumn} = @p1)`
    );
  }

  private getPool(): ConnectionPool {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool;
  }

  /**
   * Build a mssql Request with named parameters from an array.
   * Converts positional params to @p1, @p2, etc.
   */
  private buildRequest(params?: unknown[]): mssql.Request {
    const pool = this.getPool();
    const request = pool.request();
    if (params) {
      params.forEach((value, i) => {
        request.input(`p${i + 1}`, value);
      });
    }
    return request;
  }

  // ── Raw database access methods ──────────────────────────────────────────

  async rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const request = this.buildRequest(params);
    const result: IResult<T> = await request.query(sql);
    return result.recordset as T[];
  }

  async rawQueryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null> {
    const rows = await this.rawQuery<T>(sql, params);
    return rows[0] || null;
  }

  async rawExecute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const request = this.buildRequest(params);
    const result = await request.query(sql);
    // For INSERT with IDENTITY, we need SCOPE_IDENTITY()
    // The caller should use OUTPUT INSERTED.id or we fetch it here
    const lastId =
      ((result.recordset as IRecordSet<Record<string, unknown>>)?.[0]?.id as number) || 0;
    return {
      lastInsertId: lastId,
      affectedRows: result.rowsAffected?.[0] ?? 0,
    };
  }

  async rawTransaction(fn: () => Promise<void>): Promise<void> {
    const pool = this.getPool();
    const transaction = new mssql.Transaction(pool);
    await transaction.begin();
    try {
      await fn();
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  // ── MSSQL-specific overrides for INSERT (need OUTPUT INSERTED.id) ──────

  /**
   * MSSQL doesn't support lastInsertRowid like SQLite/MySQL.
   * We override methods that need auto-generated IDs to use OUTPUT INSERTED.id.
   */
  private async insertAndGetId(sql: string, params?: unknown[]): Promise<number> {
    const request = this.buildRequest(params);
    const result = await request.query(sql);
    const row = result.recordset?.[0] as Record<string, unknown> | undefined;
    return (row?.id as number) || 0;
  }

  async createMedia(
    input: import('../types').CreateMediaInput
  ): Promise<import('../types').MediaFile> {
    const id = await this.insertAndGetId(
      `INSERT INTO media_files (
        filename, original_filename, filepath, type, mime_type,
        file_size, duration, width, height, checksum, thumbnail_status, approval_status, folder_id
      ) OUTPUT INSERTED.id
      VALUES (@p1, @p2, @p3, @p4, @p5, @p6, @p7, @p8, @p9, @p10, @p11, @p12, @p13)`,
      [
        input.filename,
        input.original_filename,
        input.filepath,
        input.type,
        input.mime_type || null,
        input.file_size || null,
        input.duration || null,
        input.width || null,
        input.height || null,
        input.checksum || null,
        input.thumbnail_status || 'pending',
        'pending',
        input.folder_id ?? null,
      ]
    );

    const media = await this.getMediaById(id);
    if (!media) throw new Error('Failed to retrieve created media');
    return media;
  }

  async createPlaylist(
    input: import('../types').CreatePlaylistInput
  ): Promise<import('../types').Playlist> {
    const id = await this.insertAndGetId(
      `INSERT INTO playlists (name, description) OUTPUT INSERTED.id VALUES (@p1, @p2)`,
      [input.name, input.description || null]
    );

    const playlist = await this.getPlaylistById(id);
    if (!playlist) throw new Error('Failed to retrieve created playlist');
    return playlist;
  }

  async addPlaylistItem(
    input: import('../types').AddPlaylistItemInput
  ): Promise<import('../types').PlaylistItem> {
    const id = await this.insertAndGetId(
      `INSERT INTO playlist_items (playlist_id, media_id, order_index, image_duration)
       OUTPUT INSERTED.id VALUES (@p1, @p2, @p3, @p4)`,
      [input.playlist_id, input.media_id, input.order_index, input.image_duration || 5]
    );

    const item = await this.getPlaylistItemById(id);
    if (!item) throw new Error('Failed to retrieve created playlist item');
    return item;
  }

  async createMediaFolder(
    input: import('../types').CreateMediaFolderInput
  ): Promise<import('../types').MediaFolder> {
    const parentId = input.parent_id ?? null;
    let parentPath = '/';
    if (parentId !== null) {
      const parent = await this.getMediaFolderById(parentId);
      if (!parent) throw new Error(`Parent folder with ID ${parentId} not found`);
      parentPath = parent.path;
    }
    const id = await this.insertAndGetId(
      `INSERT INTO media_folders (name, parent_id, path, created_by)
       OUTPUT INSERTED.id VALUES (@p1, @p2, @p3, @p4)`,
      [input.name, parentId, '/', input.created_by ?? null]
    );
    const fullPath = parentPath === '/' ? `/${id}` : `${parentPath}/${id}`;
    await this.rawExecute(`UPDATE media_folders SET path = @p1 WHERE id = @p2`, [fullPath, id]);
    const folder = await this.getMediaFolderById(id);
    if (!folder) throw new Error('Failed to retrieve created folder');
    return folder;
  }

  async createClientStatus(input: CreateClientStatusInput): Promise<ClientStatus> {
    const id = await this.insertAndGetId(
      `INSERT INTO client_status (client_id, current_media_id, position, is_playing, error_message)
       OUTPUT INSERTED.id VALUES (@p1, @p2, @p3, @p4, @p5)`,
      [
        input.client_id,
        input.current_media_id || null,
        input.position || null,
        input.is_playing ? 1 : 0,
        input.error_message || null,
      ]
    );

    const status = await this.rawQueryOne<ClientStatus>(
      `SELECT * FROM client_status WHERE id = @p1`,
      [id]
    );
    if (!status) throw new Error('Failed to retrieve created client status');
    return status;
  }

  /**
   * Override getLatestClientStatus — MSSQL uses TOP 1 instead of LIMIT 1
   */
  async getLatestClientStatus(clientId: string): Promise<ClientStatus | null> {
    return this.rawQueryOne<ClientStatus>(
      `SELECT TOP 1 * FROM client_status WHERE client_id = @p1 ORDER BY timestamp DESC`,
      [clientId]
    );
  }

  getMigrationExecutor(): MigrationExecutor {
    const self = this;
    return {
      adapterType: 'mssql' as AdapterType,
      async executeSql(sql: string, params?: unknown[]): Promise<void> {
        const request = self.buildRequest(params);
        await request.query(sql);
      },
      async querySql<T>(sql: string, params?: unknown[]): Promise<T[]> {
        const request = self.buildRequest(params);
        const result = await request.query(sql);
        return result.recordset as T[];
      },
      async tableExists(name: string): Promise<boolean> {
        const pool = self.getPool();
        const result = await pool
          .request()
          .input('name', name)
          .query(`SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = @name`);
        return result.recordset.length > 0;
      },
    };
  }
}
