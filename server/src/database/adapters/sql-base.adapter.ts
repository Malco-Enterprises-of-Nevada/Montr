/**
 * Abstract base class for SQL-based database adapters.
 * Provides shared business logic (filtering, pagination, field validation)
 * that MySQL, MSSQL, and SQLite adapters all inherit.
 */

import { DatabaseAdapter } from './base.adapter';
import {
  MediaFile,
  CreateMediaInput,
  Playlist,
  CreatePlaylistInput,
  UpdatePlaylistInput,
  PlaylistItem,
  AddPlaylistItemInput,
  UpdatePlaylistItemInput,
  PlaylistWithItems,
  Client,
  CreateClientInput,
  UpdateClientInput,
  ClientStatus,
  CreateClientStatusInput,
  ClientWithStatus,
  ClientGroup,
  ClientGroupMember,
  ClientGroupWithMembers,
  CreateClientGroupInput,
  UpdateClientGroupInput,
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
  ScheduleConditions,
  ScheduleTemplate,
  ScheduleTemplateDefinition,
  CreateScheduleTemplateInput,
  ClientPlaylist,
  ClientPlaylistWithDetails,
  PlaybackLog,
  CreatePlaybackLogInput,
  PlaybackSummary,
  MediaPopularity,
  UptimeStat,
  NotificationRule,
  CreateNotificationRuleInput,
  NotificationEventType,
  NotificationHistory,
  ApprovalStatus,
  ApprovalLog,
  User,
  CreateUserInput,
  UpdateUserInput,
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  ClientFilter,
  PlaylistItemWithMedia,
  ClientTelemetryRow,
  CreateClientTelemetryInput,
  ClientLogEventRow,
  CreateClientLogEventInput,
  ClientLogLevel,
  TelemetryDiskSample,
  TelemetryTempSample,
  TelemetryNetSample,
  TelemetryMpvSample,
  TelemetryProcessSample,
  MediaFolder,
  CreateMediaFolderInput,
  UpdateMediaFolderInput,
  SubtitleTrack,
  CreateExternalSubtitleInput,
  CreateEmbeddedSubtitleInput,
  UpdateSubtitleInput,
  ThumbnailJob,
  UploadCompletionJob,
  UploadCompletionJobInput,
} from '../types';
import { MigrationExecutor } from '../migrations/runner';

/** Fields that can be updated on media_files */
const MEDIA_UPDATABLE_FIELDS = new Set([
  'filename',
  'original_filename',
  'filepath',
  'type',
  'mime_type',
  'file_size',
  'duration',
  'width',
  'height',
  'checksum',
  'thumbnail_status',
  'approval_status',
  'folder_id',
]);

/** Row result from a query with execution metadata */
export interface ExecuteResult {
  lastInsertId: number;
  affectedRows: number;
}

/**
 * Abstract SQL adapter base class.
 * Subclasses must implement the raw database access methods and
 * provide dialect-specific SQL where needed.
 */
export abstract class SqlBaseAdapter implements DatabaseAdapter {
  // ── Abstract methods (dialect-specific) ──────────────────────────────────

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;

  /** Execute a query that returns rows */
  abstract rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a query that returns a single row */
  abstract rawQueryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null>;

  /** Execute a statement (INSERT/UPDATE/DELETE) */
  abstract rawExecute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /** Execute multiple statements inside a transaction */
  abstract rawTransaction(fn: () => Promise<void>): Promise<void>;

  /** Returns a MigrationExecutor for use by the migration runner */
  abstract getMigrationExecutor(): MigrationExecutor;

  /**
   * Dialect-specific placeholder for parameterized queries.
   * SQLite/MySQL use `?`, MSSQL uses `@p1`, `@p2`, etc.
   * Override in MSSQL adapter.
   */
  protected placeholder(_index: number): string {
    return '?';
  }

  /**
   * Dialect-specific function for current timestamp in SQL.
   * SQLite: CURRENT_TIMESTAMP, MySQL: NOW(), MSSQL: GETUTCDATE()
   */
  protected abstract currentTimestampFn(): string;

  /**
   * Build a pagination clause.
   * SQLite/MySQL: LIMIT ? OFFSET ?
   * MSSQL: OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
   */
  protected paginationClause(paramStartIndex: number): string {
    return `LIMIT ${this.placeholder(paramStartIndex)} OFFSET ${this.placeholder(paramStartIndex + 1)}`;
  }

  /** Pagination params order: [limit, offset] for SQLite/MySQL, [offset, limit] for MSSQL */
  protected paginationParams(limit: number, offset: number): unknown[] {
    return [limit, offset];
  }

  // ── Media operations ─────────────────────────────────────────────────────

  async createMedia(input: CreateMediaInput): Promise<MediaFile> {
    const p = (i: number) => this.placeholder(i);
    const result = await this.rawExecute(
      `INSERT INTO media_files (
        filename, original_filename, filepath, type, mime_type,
        file_size, duration, width, height, checksum, thumbnail_status, approval_status, folder_id
      ) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)})`,
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

    const media = await this.getMediaById(result.lastInsertId);
    if (!media) throw new Error('Failed to retrieve created media');
    return media;
  }

  async getMediaById(id: number): Promise<MediaFile | null> {
    return this.rawQueryOne<MediaFile>(
      `SELECT * FROM media_files WHERE id = ${this.placeholder(1)}`,
      [id]
    );
  }

  async getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>> {
    const { page, limit } = pagination;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter) {
      const conditions: string[] = [];
      if (filter.type) {
        conditions.push(`type = ${this.placeholder(paramIndex++)}`);
        params.push(filter.type);
      }
      if (filter.search) {
        conditions.push(
          `(original_filename LIKE ${this.placeholder(paramIndex++)} OR filename LIKE ${this.placeholder(paramIndex++)})`
        );
        params.push(`%${filter.search}%`, `%${filter.search}%`);
      }
      if (filter.folder_id === 'root') {
        conditions.push(`folder_id IS NULL`);
      } else if (typeof filter.folder_id === 'number') {
        conditions.push(`folder_id = ${this.placeholder(paramIndex++)}`);
        params.push(filter.folder_id);
      }
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
    }

    const countRows = await this.rawQuery<{ count: number }>(
      `SELECT COUNT(*) as count FROM media_files ${whereClause}`,
      params
    );
    const count = countRows[0]?.count ?? 0;

    const data = await this.rawQuery<MediaFile>(
      `SELECT * FROM media_files ${whereClause} ORDER BY created_at DESC ${this.paginationClause(paramIndex)}`,
      [...params, ...this.paginationParams(limit, offset)]
    );

    return {
      data,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async updateMedia(id: number, updates: Partial<CreateMediaInput>): Promise<MediaFile> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      if (!MEDIA_UPDATABLE_FIELDS.has(key)) {
        throw new Error(`Invalid field name: ${key}`);
      }
      fields.push(`${key} = ${this.placeholder(paramIndex++)}`);
      values.push(value);
    });

    if (fields.length === 0) {
      const media = await this.getMediaById(id);
      if (!media) throw new Error(`Media with ID ${id} not found`);
      return media;
    }

    values.push(id);
    await this.rawExecute(
      `UPDATE media_files SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const media = await this.getMediaById(id);
    if (!media) throw new Error(`Media with ID ${id} not found`);
    return media;
  }

  async deleteMedia(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM media_files WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getMediaByChecksum(checksum: string): Promise<MediaFile | null> {
    return this.rawQueryOne<MediaFile>(
      `SELECT * FROM media_files WHERE checksum = ${this.placeholder(1)}`,
      [checksum]
    );
  }

  async moveMediaToFolder(mediaIds: number[], folderId: number | null): Promise<number> {
    if (mediaIds.length === 0) return 0;
    const placeholders = mediaIds.map((_, i) => this.placeholder(i + 2)).join(', ');
    const result = await this.rawExecute(
      `UPDATE media_files SET folder_id = ${this.placeholder(1)} WHERE id IN (${placeholders})`,
      [folderId, ...mediaIds]
    );
    return result.affectedRows;
  }

  async resetStuckThumbnails(): Promise<number> {
    const result = await this.rawExecute(
      `UPDATE media_files SET thumbnail_status = ${this.placeholder(1)} WHERE thumbnail_status = ${this.placeholder(2)}`,
      ['failed', 'generating']
    );
    return result.affectedRows;
  }

  // ── Thumbnail job queue ──────────────────────────────────────────────

  async enqueueThumbnailJob(mediaId: number): Promise<ThumbnailJob> {
    const result = await this.rawExecute(
      `INSERT INTO thumbnail_jobs (media_id, state) VALUES (${this.placeholder(1)}, 'queued')`,
      [mediaId]
    );
    const job = await this.rawQueryOne<ThumbnailJob>(
      `SELECT * FROM thumbnail_jobs WHERE id = ${this.placeholder(1)}`,
      [result.lastInsertId]
    );
    if (!job) throw new Error(`Thumbnail job ${result.lastInsertId} not found after insert`);
    return job;
  }

  async claimNextThumbnailJob(): Promise<ThumbnailJob | null> {
    // Atomic claim via compare-and-set. Single-process SQLite has no real
    // contention but this works correctly if we ever add a second poller.
    // Loop until we either claim or the queue is empty.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = await this.rawQueryOne<ThumbnailJob>(
        `SELECT * FROM thumbnail_jobs WHERE state = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`
      );
      if (!candidate) return null;

      const claim = await this.rawExecute(
        `UPDATE thumbnail_jobs SET state = 'running', attempts = attempts + 1, updated_at = ${this.currentTimestampFn()}
         WHERE id = ${this.placeholder(1)} AND state = 'queued'`,
        [candidate.id]
      );
      if (claim.affectedRows === 1) {
        return await this.rawQueryOne<ThumbnailJob>(
          `SELECT * FROM thumbnail_jobs WHERE id = ${this.placeholder(1)}`,
          [candidate.id]
        );
      }
      // Someone else claimed it — try the next one.
    }
  }

  async markThumbnailJobDone(jobId: number): Promise<void> {
    await this.rawExecute(
      `UPDATE thumbnail_jobs SET state = 'done', last_error = NULL, updated_at = ${this.currentTimestampFn()} WHERE id = ${this.placeholder(1)}`,
      [jobId]
    );
  }

  async markThumbnailJobFailed(jobId: number, error: string): Promise<void> {
    await this.rawExecute(
      `UPDATE thumbnail_jobs SET state = 'failed', last_error = ${this.placeholder(1)}, updated_at = ${this.currentTimestampFn()} WHERE id = ${this.placeholder(2)}`,
      [error.slice(0, 2000), jobId]
    );
  }

  async requeueRunningThumbnailJobs(): Promise<number> {
    const result = await this.rawExecute(
      `UPDATE thumbnail_jobs SET state = 'queued', updated_at = ${this.currentTimestampFn()} WHERE state = 'running'`
    );
    return result.affectedRows;
  }

  async getLatestThumbnailJobForMedia(mediaId: number): Promise<ThumbnailJob | null> {
    return this.rawQueryOne<ThumbnailJob>(
      `SELECT * FROM thumbnail_jobs WHERE media_id = ${this.placeholder(1)} ORDER BY id DESC LIMIT 1`,
      [mediaId]
    );
  }

  // ── Upload completion job queue ──────────────────────────────────────

  async enqueueUploadCompletionJob(input: UploadCompletionJobInput): Promise<UploadCompletionJob> {
    // Idempotent on upload_id: if a row exists (from a retried /complete),
    // return that one. Uses INSERT with a uniqueness collision tolerated
    // via the dialect-specific upsert hint; fall back to SELECT either way.
    const insertSql = this.upsertIgnoreSql(
      `INSERT INTO upload_completion_jobs (
        upload_id, storage_backend, storage_key, original_filename,
        mime_type, total_size, folder_id, state
      ) VALUES (
        ${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)},
        ${this.placeholder(4)}, ${this.placeholder(5)}, ${this.placeholder(6)},
        ${this.placeholder(7)}, 'queued'
      )`,
      'upload_id'
    );
    await this.rawExecute(insertSql, [
      input.uploadId,
      input.storageBackend,
      input.storageKey,
      input.originalFilename,
      input.mimeType,
      input.totalSize,
      input.folderId,
    ]);
    const job = await this.rawQueryOne<UploadCompletionJob>(
      `SELECT * FROM upload_completion_jobs WHERE upload_id = ${this.placeholder(1)}`,
      [input.uploadId]
    );
    if (!job) {
      throw new Error(`Upload completion job for ${input.uploadId} not found after insert`);
    }
    return job;
  }

  async claimNextUploadCompletionJob(): Promise<UploadCompletionJob | null> {
    // Same atomic compare-and-set pattern as claimNextThumbnailJob.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = await this.rawQueryOne<UploadCompletionJob>(
        `SELECT * FROM upload_completion_jobs WHERE state = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`
      );
      if (!candidate) return null;

      const claim = await this.rawExecute(
        `UPDATE upload_completion_jobs SET state = 'running', attempts = attempts + 1, updated_at = ${this.currentTimestampFn()}
         WHERE id = ${this.placeholder(1)} AND state = 'queued'`,
        [candidate.id]
      );
      if (claim.affectedRows === 1) {
        return await this.rawQueryOne<UploadCompletionJob>(
          `SELECT * FROM upload_completion_jobs WHERE id = ${this.placeholder(1)}`,
          [candidate.id]
        );
      }
    }
  }

  async markUploadCompletionJobDone(jobId: number, mediaId: number): Promise<void> {
    await this.rawExecute(
      `UPDATE upload_completion_jobs SET state = 'done', media_id = ${this.placeholder(1)}, last_error = NULL, updated_at = ${this.currentTimestampFn()} WHERE id = ${this.placeholder(2)}`,
      [mediaId, jobId]
    );
  }

  async markUploadCompletionJobDuplicate(jobId: number, existingMediaId: number): Promise<void> {
    await this.rawExecute(
      `UPDATE upload_completion_jobs SET state = 'duplicate', existing_media_id = ${this.placeholder(1)}, last_error = NULL, updated_at = ${this.currentTimestampFn()} WHERE id = ${this.placeholder(2)}`,
      [existingMediaId, jobId]
    );
  }

  async markUploadCompletionJobFailed(jobId: number, error: string): Promise<void> {
    await this.rawExecute(
      `UPDATE upload_completion_jobs SET state = 'failed', last_error = ${this.placeholder(1)}, updated_at = ${this.currentTimestampFn()} WHERE id = ${this.placeholder(2)}`,
      [error.slice(0, 2000), jobId]
    );
  }

  async requeueRunningUploadCompletionJobs(): Promise<number> {
    const result = await this.rawExecute(
      `UPDATE upload_completion_jobs SET state = 'queued', updated_at = ${this.currentTimestampFn()} WHERE state = 'running'`
    );
    return result.affectedRows;
  }

  async getUploadCompletionJobByUploadId(uploadId: string): Promise<UploadCompletionJob | null> {
    return this.rawQueryOne<UploadCompletionJob>(
      `SELECT * FROM upload_completion_jobs WHERE upload_id = ${this.placeholder(1)}`,
      [uploadId]
    );
  }

  /**
   * Dialect-specific "INSERT but ignore duplicate-key collision". Default is
   * SQLite's `INSERT OR IGNORE`; MySQL overrides to `INSERT IGNORE`, MSSQL
   * would override to a MERGE-based pattern. `uniqueColumn` is only used by
   * adapters that need explicit ON CONFLICT targets.
   */
  protected upsertIgnoreSql(insertSql: string, _uniqueColumn: string): string {
    return insertSql.replace(/^INSERT\s+INTO/, 'INSERT OR IGNORE INTO');
  }

  // ── Media folder operations ──────────────────────────────────────────────

  async createMediaFolder(input: CreateMediaFolderInput): Promise<MediaFolder> {
    const parentId = input.parent_id ?? null;
    let parentPath = '/';
    if (parentId !== null) {
      const parent = await this.getMediaFolderById(parentId);
      if (!parent) throw new Error(`Parent folder with ID ${parentId} not found`);
      parentPath = parent.path;
    }
    // Insert with placeholder path, then update path to include id
    const result = await this.rawExecute(
      `INSERT INTO media_folders (name, parent_id, path, created_by) VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)})`,
      [input.name, parentId, '/', input.created_by ?? null]
    );
    const id = result.lastInsertId;
    const fullPath = parentPath === '/' ? `/${id}` : `${parentPath}/${id}`;
    await this.rawExecute(
      `UPDATE media_folders SET path = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
      [fullPath, id]
    );
    const folder = await this.getMediaFolderById(id);
    if (!folder) throw new Error('Failed to retrieve created folder');
    return folder;
  }

  async getMediaFolderById(id: number): Promise<MediaFolder | null> {
    return this.rawQueryOne<MediaFolder>(
      `SELECT * FROM media_folders WHERE id = ${this.placeholder(1)}`,
      [id]
    );
  }

  async getAllMediaFolders(): Promise<MediaFolder[]> {
    return this.rawQuery<MediaFolder>('SELECT * FROM media_folders ORDER BY path ASC, name ASC');
  }

  async updateMediaFolder(id: number, input: UpdateMediaFolderInput): Promise<MediaFolder> {
    const folder = await this.getMediaFolderById(id);
    if (!folder) throw new Error(`Folder with ID ${id} not found`);

    await this.rawTransaction(async () => {
      if (input.name !== undefined) {
        await this.rawExecute(
          `UPDATE media_folders SET name = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
          [input.name, id]
        );
      }

      if (input.parent_id !== undefined && input.parent_id !== folder.parent_id) {
        const newParentId = input.parent_id;
        let newParentPath = '/';
        if (newParentId !== null) {
          const newParent = await this.getMediaFolderById(newParentId);
          if (!newParent) throw new Error(`Parent folder ${newParentId} not found`);
          // Cycle check: new parent must not be the folder itself or a descendant.
          if (newParentId === id) throw new Error('A folder cannot be its own parent');
          if (newParent.path === folder.path || newParent.path.startsWith(`${folder.path}/`)) {
            throw new Error('Cannot move folder into its own descendant');
          }
          newParentPath = newParent.path;
        }

        const newPath = newParentPath === '/' ? `/${id}` : `${newParentPath}/${id}`;
        const oldPath = folder.path;

        await this.rawExecute(
          `UPDATE media_folders SET parent_id = ${this.placeholder(1)}, path = ${this.placeholder(2)} WHERE id = ${this.placeholder(3)}`,
          [newParentId, newPath, id]
        );

        // Recompute descendants' paths: replace prefix oldPath with newPath.
        // Select all descendants by the old path prefix.
        const descendants = await this.rawQuery<MediaFolder>(
          `SELECT * FROM media_folders WHERE path LIKE ${this.placeholder(1)}`,
          [`${oldPath}/%`]
        );
        for (const d of descendants) {
          const suffix = d.path.slice(oldPath.length); // starts with '/'
          const updated = `${newPath}${suffix}`;
          await this.rawExecute(
            `UPDATE media_folders SET path = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
            [updated, d.id]
          );
        }
      }
    });

    const updated = await this.getMediaFolderById(id);
    if (!updated) throw new Error(`Folder with ID ${id} not found`);
    return updated;
  }

  async deleteMediaFolder(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM media_folders WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getMediaFolderDescendants(id: number): Promise<MediaFolder[]> {
    const folder = await this.getMediaFolderById(id);
    if (!folder) return [];
    return this.rawQuery<MediaFolder>(
      `SELECT * FROM media_folders WHERE path LIKE ${this.placeholder(1)} ORDER BY path ASC`,
      [`${folder.path}/%`]
    );
  }

  async getMediaFolderContentCounts(id: number): Promise<{ media: number; subfolders: number }> {
    const mediaRows = await this.rawQuery<{ count: number }>(
      `SELECT COUNT(*) as count FROM media_files WHERE folder_id = ${this.placeholder(1)}`,
      [id]
    );
    const subfolderRows = await this.rawQuery<{ count: number }>(
      `SELECT COUNT(*) as count FROM media_folders WHERE parent_id = ${this.placeholder(1)}`,
      [id]
    );
    return {
      media: Number(mediaRows[0]?.count ?? 0),
      subfolders: Number(subfolderRows[0]?.count ?? 0),
    };
  }

  // ── Subtitle track operations ────────────────────────────────────────────

  /** Map raw DB row (is_default/is_forced as INTEGER 0/1) to typed SubtitleTrack */
  private mapSubtitleRow(row: Record<string, unknown>): SubtitleTrack {
    return {
      id: row.id as number,
      media_file_id: row.media_file_id as number,
      kind: row.kind as SubtitleTrack['kind'],
      storage_filename: (row.storage_filename as string | null) ?? null,
      original_filename: (row.original_filename as string | null) ?? null,
      format: (row.format as SubtitleTrack['format']) ?? null,
      size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
      checksum: (row.checksum as string | null) ?? null,
      stream_index: row.stream_index == null ? null : Number(row.stream_index),
      codec: (row.codec as string | null) ?? null,
      language: (row.language as string | null) ?? null,
      label: (row.label as string | null) ?? null,
      is_default: Boolean(row.is_default),
      is_forced: Boolean(row.is_forced),
      created_at: row.created_at as string,
    };
  }

  /** If input.is_default, clear the flag on all other tracks of the same kind for this media. */
  private async clearDefaultFlagSiblings(
    mediaFileId: number,
    kind: 'external' | 'embedded',
    exceptId?: number
  ): Promise<void> {
    const params: unknown[] = [mediaFileId, kind];
    let whereExcept = '';
    if (exceptId !== undefined) {
      whereExcept = ` AND id <> ${this.placeholder(3)}`;
      params.push(exceptId);
    }
    await this.rawExecute(
      `UPDATE subtitle_tracks SET is_default = 0
       WHERE media_file_id = ${this.placeholder(1)} AND kind = ${this.placeholder(2)}${whereExcept}`,
      params
    );
  }

  async createExternalSubtitle(input: CreateExternalSubtitleInput): Promise<SubtitleTrack> {
    if (input.is_default) {
      await this.clearDefaultFlagSiblings(input.media_file_id, 'external');
    }
    const p = (i: number) => this.placeholder(i);
    const result = await this.rawExecute(
      `INSERT INTO subtitle_tracks (
        media_file_id, kind, storage_filename, original_filename, format,
        size_bytes, checksum, language, label, is_default, is_forced
      ) VALUES (${p(1)}, 'external', ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)})`,
      [
        input.media_file_id,
        input.storage_filename,
        input.original_filename,
        input.format,
        input.size_bytes,
        input.checksum,
        input.language ?? null,
        input.label ?? null,
        input.is_default ? 1 : 0,
        input.is_forced ? 1 : 0,
      ]
    );
    const row = await this.getSubtitleById(result.lastInsertId);
    if (!row) throw new Error('Failed to retrieve created subtitle');
    return row;
  }

  async createEmbeddedSubtitle(input: CreateEmbeddedSubtitleInput): Promise<SubtitleTrack> {
    // Idempotent upsert: if the row already exists for this (media, stream_index),
    // update its metadata in place so re-ingests stay in sync with current flags.
    const existing = await this.rawQueryOne<Record<string, unknown>>(
      `SELECT * FROM subtitle_tracks
       WHERE media_file_id = ${this.placeholder(1)} AND kind = 'embedded' AND stream_index = ${this.placeholder(2)}`,
      [input.media_file_id, input.stream_index]
    );

    if (existing) {
      const id = existing.id as number;
      if (input.is_default) {
        await this.clearDefaultFlagSiblings(input.media_file_id, 'embedded', id);
      }
      await this.rawExecute(
        `UPDATE subtitle_tracks SET
          codec = ${this.placeholder(1)}, language = ${this.placeholder(2)},
          label = ${this.placeholder(3)}, is_default = ${this.placeholder(4)}, is_forced = ${this.placeholder(5)}
         WHERE id = ${this.placeholder(6)}`,
        [
          input.codec,
          input.language ?? null,
          input.label ?? null,
          input.is_default ? 1 : 0,
          input.is_forced ? 1 : 0,
          id,
        ]
      );
      const row = await this.getSubtitleById(id);
      if (!row) throw new Error('Failed to retrieve updated subtitle');
      return row;
    }

    if (input.is_default) {
      await this.clearDefaultFlagSiblings(input.media_file_id, 'embedded');
    }
    const p = (i: number) => this.placeholder(i);
    const result = await this.rawExecute(
      `INSERT INTO subtitle_tracks (
        media_file_id, kind, stream_index, codec, language, label, is_default, is_forced
      ) VALUES (${p(1)}, 'embedded', ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})`,
      [
        input.media_file_id,
        input.stream_index,
        input.codec,
        input.language ?? null,
        input.label ?? null,
        input.is_default ? 1 : 0,
        input.is_forced ? 1 : 0,
      ]
    );
    const row = await this.getSubtitleById(result.lastInsertId);
    if (!row) throw new Error('Failed to retrieve created subtitle');
    return row;
  }

  async getSubtitleById(id: number): Promise<SubtitleTrack | null> {
    const row = await this.rawQueryOne<Record<string, unknown>>(
      `SELECT * FROM subtitle_tracks WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    return row ? this.mapSubtitleRow(row) : null;
  }

  async getSubtitlesForMedia(mediaFileId: number): Promise<SubtitleTrack[]> {
    const rows = await this.rawQuery<Record<string, unknown>>(
      `SELECT * FROM subtitle_tracks
       WHERE media_file_id = ${this.placeholder(1)}
       ORDER BY is_default DESC, kind ASC, id ASC`,
      [mediaFileId]
    );
    return rows.map((r) => this.mapSubtitleRow(r));
  }

  async updateSubtitle(id: number, input: UpdateSubtitleInput): Promise<SubtitleTrack> {
    const existing = await this.getSubtitleById(id);
    if (!existing) throw new Error(`Subtitle with ID ${id} not found`);

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.language !== undefined) {
      fields.push(`language = ${this.placeholder(paramIndex++)}`);
      values.push(input.language);
    }
    if (input.label !== undefined) {
      fields.push(`label = ${this.placeholder(paramIndex++)}`);
      values.push(input.label);
    }
    if (input.is_default !== undefined) {
      if (input.is_default) {
        await this.clearDefaultFlagSiblings(existing.media_file_id, existing.kind, id);
      }
      fields.push(`is_default = ${this.placeholder(paramIndex++)}`);
      values.push(input.is_default ? 1 : 0);
    }
    if (input.is_forced !== undefined) {
      fields.push(`is_forced = ${this.placeholder(paramIndex++)}`);
      values.push(input.is_forced ? 1 : 0);
    }

    if (fields.length === 0) return existing;

    values.push(id);
    await this.rawExecute(
      `UPDATE subtitle_tracks SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );
    const updated = await this.getSubtitleById(id);
    if (!updated) throw new Error(`Subtitle with ID ${id} not found`);
    return updated;
  }

  async deleteSubtitle(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM subtitle_tracks WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getSubtitleCountsByMedia(): Promise<Record<number, number>> {
    const rows = await this.rawQuery<{ media_file_id: number; cnt: number }>(
      `SELECT media_file_id, COUNT(*) AS cnt FROM subtitle_tracks GROUP BY media_file_id`
    );
    const counts: Record<number, number> = {};
    for (const row of rows) {
      counts[Number(row.media_file_id)] = Number(row.cnt);
    }
    return counts;
  }

  async pruneEmbeddedSubtitles(mediaFileId: number, keepStreamIndexes: number[]): Promise<number> {
    if (keepStreamIndexes.length === 0) {
      const result = await this.rawExecute(
        `DELETE FROM subtitle_tracks WHERE media_file_id = ${this.placeholder(1)} AND kind = 'embedded'`,
        [mediaFileId]
      );
      return result.affectedRows;
    }
    const keepPlaceholders = keepStreamIndexes.map((_, i) => this.placeholder(i + 2)).join(', ');
    const result = await this.rawExecute(
      `DELETE FROM subtitle_tracks
       WHERE media_file_id = ${this.placeholder(1)} AND kind = 'embedded'
         AND stream_index NOT IN (${keepPlaceholders})`,
      [mediaFileId, ...keepStreamIndexes]
    );
    return result.affectedRows;
  }

  // ── Playlist operations ──────────────────────────────────────────────────

  async createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
    const result = await this.rawExecute(
      `INSERT INTO playlists (name, description) VALUES (${this.placeholder(1)}, ${this.placeholder(2)})`,
      [input.name, input.description || null]
    );

    const playlist = await this.getPlaylistById(result.lastInsertId);
    if (!playlist) throw new Error('Failed to retrieve created playlist');
    return playlist;
  }

  async getPlaylistById(id: number): Promise<Playlist | null> {
    return this.rawQueryOne<Playlist>(`SELECT * FROM playlists WHERE id = ${this.placeholder(1)}`, [
      id,
    ]);
  }

  async getPlaylistWithItems(id: number): Promise<PlaylistWithItems | null> {
    const playlist = await this.getPlaylistById(id);
    if (!playlist) return null;

    const rows = await this.rawQuery<
      PlaylistItem & {
        media_id: number;
        filename: string;
        original_filename: string;
        filepath: string;
        type: 'video' | 'image';
        mime_type: string | null;
        file_size: number | null;
        duration: number | null;
        width: number | null;
        height: number | null;
        checksum: string | null;
        thumbnail_status: import('../types').ThumbnailStatus;
        approval_status: import('../types').ApprovalStatus;
        folder_id: number | null;
        media_created_at: string;
        media_updated_at: string;
      }
    >(
      `SELECT
        pi.id, pi.playlist_id, pi.media_id, pi.order_index, pi.image_duration, pi.created_at,
        mf.id as media_id, mf.filename, mf.original_filename, mf.filepath, mf.type,
        mf.mime_type, mf.file_size, mf.duration, mf.width, mf.height, mf.checksum,
        mf.thumbnail_status, mf.approval_status, mf.folder_id,
        mf.created_at as media_created_at, mf.updated_at as media_updated_at
      FROM playlist_items pi
      JOIN media_files mf ON pi.media_id = mf.id
      WHERE pi.playlist_id = ${this.placeholder(1)}
      ORDER BY pi.order_index ASC`,
      [id]
    );

    const items: PlaylistItemWithMedia[] = rows.map((row) => ({
      id: row.id,
      playlist_id: row.playlist_id,
      media_id: row.media_id,
      order_index: row.order_index,
      image_duration: row.image_duration,
      created_at: row.created_at,
      media: {
        id: row.media_id,
        filename: row.filename,
        original_filename: row.original_filename,
        filepath: row.filepath,
        type: row.type,
        mime_type: row.mime_type,
        file_size: row.file_size,
        duration: row.duration,
        width: row.width,
        height: row.height,
        checksum: row.checksum,
        thumbnail_status: row.thumbnail_status || 'pending',
        approval_status: row.approval_status || 'pending',
        folder_id: row.folder_id ?? null,
        created_at: row.media_created_at,
        updated_at: row.media_updated_at,
      },
    }));

    return { ...playlist, items };
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    return this.rawQuery<Playlist>('SELECT * FROM playlists ORDER BY created_at DESC');
  }

  async updatePlaylist(id: number, input: UpdatePlaylistInput): Promise<Playlist> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      fields.push(`name = ${this.placeholder(paramIndex++)}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push(`description = ${this.placeholder(paramIndex++)}`);
      values.push(input.description);
    }

    if (fields.length === 0) {
      const playlist = await this.getPlaylistById(id);
      if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
      return playlist;
    }

    values.push(id);
    await this.rawExecute(
      `UPDATE playlists SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const playlist = await this.getPlaylistById(id);
    if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
    return playlist;
  }

  async deletePlaylist(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM playlists WHERE id = ${this.placeholder(1)}`, [id]);
  }

  // ── Playlist item operations ─────────────────────────────────────────────

  async addPlaylistItem(input: AddPlaylistItemInput): Promise<PlaylistItem> {
    const result = await this.rawExecute(
      `INSERT INTO playlist_items (playlist_id, media_id, order_index, image_duration)
       VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)})`,
      [input.playlist_id, input.media_id, input.order_index, input.image_duration || 5]
    );

    const item = await this.getPlaylistItemById(result.lastInsertId);
    if (!item) throw new Error('Failed to retrieve created playlist item');
    return item;
  }

  async getPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
    return this.rawQuery<PlaylistItem>(
      `SELECT * FROM playlist_items WHERE playlist_id = ${this.placeholder(1)} ORDER BY order_index ASC`,
      [playlistId]
    );
  }

  async getPlaylistItemById(itemId: number): Promise<PlaylistItem | null> {
    return this.rawQueryOne<PlaylistItem>(
      `SELECT * FROM playlist_items WHERE id = ${this.placeholder(1)}`,
      [itemId]
    );
  }

  async updatePlaylistItem(itemId: number, input: UpdatePlaylistItemInput): Promise<PlaylistItem> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.order_index !== undefined) {
      fields.push(`order_index = ${this.placeholder(paramIndex++)}`);
      values.push(input.order_index);
    }
    if (input.image_duration !== undefined) {
      fields.push(`image_duration = ${this.placeholder(paramIndex++)}`);
      values.push(input.image_duration);
    }

    if (fields.length === 0) {
      const item = await this.getPlaylistItemById(itemId);
      if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
      return item;
    }

    values.push(itemId);
    await this.rawExecute(
      `UPDATE playlist_items SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const item = await this.getPlaylistItemById(itemId);
    if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
    return item;
  }

  async deletePlaylistItem(itemId: number): Promise<void> {
    await this.rawExecute(`DELETE FROM playlist_items WHERE id = ${this.placeholder(1)}`, [itemId]);
  }

  async reorderPlaylistItems(_playlistId: number, itemIds: number[]): Promise<void> {
    await this.rawTransaction(async () => {
      // First, set all to negative temporary values to avoid UNIQUE constraint violations
      for (let i = 0; i < itemIds.length; i++) {
        await this.rawExecute(
          `UPDATE playlist_items SET order_index = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
          [-(i + 1), itemIds[i]]
        );
      }
      // Then set to final values
      for (let i = 0; i < itemIds.length; i++) {
        await this.rawExecute(
          `UPDATE playlist_items SET order_index = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
          [i, itemIds[i]]
        );
      }
    });
  }

  // ── Client operations ────────────────────────────────────────────────────

  async createClient(input: CreateClientInput): Promise<Client> {
    await this.rawExecute(
      `INSERT INTO clients (id, name, version, capabilities, last_seen)
       VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)}, ${this.currentTimestampFn()})`,
      [input.id, input.name, input.version || null, input.capabilities || null]
    );

    const client = await this.getClientById(input.id);
    if (!client) throw new Error('Failed to retrieve created client');
    return client;
  }

  async getClientById(id: string): Promise<Client | null> {
    return this.rawQueryOne<Client>(`SELECT * FROM clients WHERE id = ${this.placeholder(1)}`, [
      id,
    ]);
  }

  async getAllClients(filter?: ClientFilter): Promise<Client[]> {
    let whereClause = '';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter) {
      const conditions: string[] = [];
      if (filter.status) {
        conditions.push(`status = ${this.placeholder(paramIndex++)}`);
        params.push(filter.status);
      }
      if (filter.assigned_playlist_id !== undefined) {
        conditions.push(`assigned_playlist_id = ${this.placeholder(paramIndex++)}`);
        params.push(filter.assigned_playlist_id);
      }
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
    }

    return this.rawQuery<Client>(
      `SELECT * FROM clients ${whereClause} ORDER BY created_at DESC`,
      params
    );
  }

  async updateClient(id: string, input: UpdateClientInput): Promise<Client> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      fields.push(`name = ${this.placeholder(paramIndex++)}`);
      values.push(input.name);
    }
    if (input.assigned_playlist_id !== undefined) {
      fields.push(`assigned_playlist_id = ${this.placeholder(paramIndex++)}`);
      values.push(input.assigned_playlist_id);
    }
    if (input.status !== undefined) {
      fields.push(`status = ${this.placeholder(paramIndex++)}`);
      values.push(input.status);
    }
    if (input.last_seen !== undefined) {
      fields.push(`last_seen = ${this.placeholder(paramIndex++)}`);
      values.push(input.last_seen);
    }
    if (input.version !== undefined) {
      fields.push(`version = ${this.placeholder(paramIndex++)}`);
      values.push(input.version);
    }
    if (input.capabilities !== undefined) {
      fields.push(`capabilities = ${this.placeholder(paramIndex++)}`);
      values.push(input.capabilities);
    }

    if (fields.length === 0) {
      const client = await this.getClientById(id);
      if (!client) throw new Error(`Client with ID ${id} not found`);
      return client;
    }

    values.push(id);
    await this.rawExecute(
      `UPDATE clients SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const client = await this.getClientById(id);
    if (!client) throw new Error(`Client with ID ${id} not found`);
    return client;
  }

  async deleteClient(id: string): Promise<void> {
    await this.rawExecute(`DELETE FROM clients WHERE id = ${this.placeholder(1)}`, [id]);
  }

  // ── Client status operations ─────────────────────────────────────────────

  async createClientStatus(input: CreateClientStatusInput): Promise<ClientStatus> {
    const result = await this.rawExecute(
      `INSERT INTO client_status (client_id, current_media_id, position, is_playing, error_message)
       VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)}, ${this.placeholder(5)})`,
      [
        input.client_id,
        input.current_media_id || null,
        input.position || null,
        input.is_playing ? 1 : 0,
        input.error_message || null,
      ]
    );

    const status = await this.rawQueryOne<ClientStatus>(
      `SELECT * FROM client_status WHERE id = ${this.placeholder(1)}`,
      [result.lastInsertId]
    );
    if (!status) throw new Error('Failed to retrieve created client status');
    return status;
  }

  async getLatestClientStatus(clientId: string): Promise<ClientStatus | null> {
    return this.rawQueryOne<ClientStatus>(
      `SELECT cs.*, mf.original_filename AS media_filename FROM client_status cs LEFT JOIN media_files mf ON cs.current_media_id = mf.id WHERE cs.client_id = ${this.placeholder(1)} ORDER BY cs.timestamp DESC, cs.id DESC LIMIT 1`,
      [clientId]
    );
  }

  async getClientWithStatus(clientId: string): Promise<ClientWithStatus | null> {
    const client = await this.getClientById(clientId);
    if (!client) return null;

    const status = await this.getLatestClientStatus(clientId);
    return { ...client, current_status: status };
  }

  // ── Client group operations ─────────────────────────────────────────────

  async createClientGroup(input: CreateClientGroupInput): Promise<ClientGroup> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_groups (name, description) VALUES (${p(1)}, ${p(2)})`,
      [input.name, input.description || null]
    );
    const group = await this.getClientGroupById(result.lastInsertId);
    if (!group) throw new Error('Failed to retrieve created client group');
    return group;
  }

  async getClientGroupById(id: number): Promise<ClientGroup | null> {
    return this.rawQueryOne<ClientGroup>(
      `SELECT * FROM client_groups WHERE id = ${this.placeholder(1)}`,
      [id]
    );
  }

  async getClientGroupWithMembers(id: number): Promise<ClientGroupWithMembers | null> {
    const group = await this.getClientGroupById(id);
    if (!group) return null;
    const members = await this.getGroupMembers(id);
    return { ...group, members };
  }

  async getAllClientGroups(): Promise<ClientGroup[]> {
    return this.rawQuery<ClientGroup>('SELECT * FROM client_groups ORDER BY name ASC');
  }

  async updateClientGroup(id: number, input: UpdateClientGroupInput): Promise<ClientGroup> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      fields.push(`name = ${this.placeholder(paramIndex++)}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push(`description = ${this.placeholder(paramIndex++)}`);
      values.push(input.description);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE client_groups SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
        values
      );
    }

    const group = await this.getClientGroupById(id);
    if (!group) throw new Error(`Client group with ID ${id} not found`);
    return group;
  }

  async deleteClientGroup(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM client_groups WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async addClientToGroup(groupId: number, clientId: string): Promise<ClientGroupMember> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_group_members (group_id, client_id) VALUES (${p(1)}, ${p(2)})`,
      [groupId, clientId]
    );
    const member = await this.rawQueryOne<ClientGroupMember>(
      `SELECT * FROM client_group_members WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!member) throw new Error('Failed to retrieve created group member');
    return member;
  }

  async removeClientFromGroup(groupId: number, clientId: string): Promise<void> {
    const p = this.placeholder;
    await this.rawExecute(
      `DELETE FROM client_group_members WHERE group_id = ${p(1)} AND client_id = ${p(2)}`,
      [groupId, clientId]
    );
  }

  async getGroupMembers(groupId: number): Promise<Client[]> {
    return this.rawQuery<Client>(
      `SELECT c.* FROM clients c
       JOIN client_group_members cgm ON c.id = cgm.client_id
       WHERE cgm.group_id = ${this.placeholder(1)}
       ORDER BY c.name ASC`,
      [groupId]
    );
  }

  async getClientGroups(clientId: string): Promise<ClientGroup[]> {
    return this.rawQuery<ClientGroup>(
      `SELECT cg.* FROM client_groups cg
       JOIN client_group_members cgm ON cg.id = cgm.group_id
       WHERE cgm.client_id = ${this.placeholder(1)}
       ORDER BY cg.name ASC`,
      [clientId]
    );
  }

  // ── Schedule operations ─────────────────────────────────────────────────

  private scheduleRowToObj(row: Record<string, unknown> & { enabled: number | boolean }): Schedule {
    let conditions: ScheduleConditions | null = null;
    const raw = row.conditions as string | null | undefined;
    if (raw) {
      try {
        conditions = JSON.parse(raw) as ScheduleConditions;
      } catch {
        conditions = null;
      }
    }
    return {
      id: row.id as number,
      name: row.name as string,
      playlist_id: row.playlist_id as number,
      client_id: (row.client_id as string) ?? null,
      group_id: (row.group_id as number) ?? null,
      start_time: (row.start_time as string) ?? null,
      end_time: (row.end_time as string) ?? null,
      days_of_week: (row.days_of_week as string) ?? '0,1,2,3,4,5,6',
      priority: (row.priority as number) ?? 50,
      enabled: Boolean(row.enabled),
      cron_expression: (row.cron_expression as string) ?? null,
      duration_seconds: (row.duration_seconds as number) ?? null,
      timezone: (row.timezone as string) ?? null,
      conditions,
      interrupt_mode:
        ((row.interrupt_mode as string) ?? 'assign') === 'interrupt' ? 'interrupt' : 'assign',
      template_id: (row.template_id as number) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO schedules (
         name, playlist_id, client_id, group_id, start_time, end_time, days_of_week,
         priority, enabled, cron_expression, duration_seconds, timezone, conditions,
         interrupt_mode, template_id
       ) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)}, ${p(14)}, ${p(15)})`,
      [
        input.name,
        input.playlist_id,
        input.client_id || null,
        input.group_id || null,
        input.start_time || null,
        input.end_time || null,
        input.days_of_week || '0,1,2,3,4,5,6',
        input.priority ?? 50,
        input.enabled !== false ? 1 : 0,
        input.cron_expression || null,
        input.duration_seconds ?? null,
        input.timezone || null,
        input.conditions ? JSON.stringify(input.conditions) : null,
        input.interrupt_mode || 'assign',
        input.template_id ?? null,
      ]
    );
    const schedule = await this.getScheduleById(result.lastInsertId);
    if (!schedule) throw new Error('Failed to retrieve created schedule');
    return schedule;
  }

  async getScheduleById(id: number): Promise<Schedule | null> {
    const row = await this.rawQueryOne<Record<string, unknown> & { enabled: number }>(
      `SELECT * FROM schedules WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!row) return null;
    return this.scheduleRowToObj(row);
  }

  async getAllSchedules(): Promise<Schedule[]> {
    const rows = await this.rawQuery<Record<string, unknown> & { enabled: number }>(
      'SELECT * FROM schedules ORDER BY priority DESC, name ASC'
    );
    return rows.map((r) => this.scheduleRowToObj(r));
  }

  async updateSchedule(id: number, input: UpdateScheduleInput): Promise<Schedule> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const updatable: Record<string, unknown> = {};
    if (input.name !== undefined) updatable.name = input.name;
    if (input.playlist_id !== undefined) updatable.playlist_id = input.playlist_id;
    if (input.client_id !== undefined) updatable.client_id = input.client_id;
    if (input.group_id !== undefined) updatable.group_id = input.group_id;
    if (input.start_time !== undefined) updatable.start_time = input.start_time;
    if (input.end_time !== undefined) updatable.end_time = input.end_time;
    if (input.days_of_week !== undefined) updatable.days_of_week = input.days_of_week;
    if (input.priority !== undefined) updatable.priority = input.priority;
    if (input.enabled !== undefined) updatable.enabled = input.enabled ? 1 : 0;
    if (input.cron_expression !== undefined) updatable.cron_expression = input.cron_expression;
    if (input.duration_seconds !== undefined) updatable.duration_seconds = input.duration_seconds;
    if (input.timezone !== undefined) updatable.timezone = input.timezone;
    if (input.conditions !== undefined) {
      updatable.conditions = input.conditions ? JSON.stringify(input.conditions) : null;
    }
    if (input.interrupt_mode !== undefined) updatable.interrupt_mode = input.interrupt_mode;
    if (input.template_id !== undefined) updatable.template_id = input.template_id;

    for (const [key, value] of Object.entries(updatable)) {
      fields.push(`${key} = ${this.placeholder(paramIndex++)}`);
      values.push(value);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE schedules SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
        values
      );
    }

    const schedule = await this.getScheduleById(id);
    if (!schedule) throw new Error(`Schedule with ID ${id} not found`);
    return schedule;
  }

  async deleteSchedule(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM schedules WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getEnabledSchedules(): Promise<Schedule[]> {
    const rows = await this.rawQuery<Record<string, unknown> & { enabled: number }>(
      `SELECT * FROM schedules WHERE enabled = 1 ORDER BY priority DESC`
    );
    return rows.map((r) => this.scheduleRowToObj(r));
  }

  // ── Schedule template operations ────────────────────────────────────────

  private scheduleTemplateRowToObj(
    row: Record<string, unknown> & { is_builtin: number | boolean }
  ): ScheduleTemplate {
    let definition: ScheduleTemplateDefinition = { mode: 'simple' };
    const raw = row.definition_json as string | null | undefined;
    if (raw) {
      try {
        definition = JSON.parse(raw) as ScheduleTemplateDefinition;
      } catch {
        // keep default
      }
    }
    return {
      id: row.id as number,
      name: row.name as string,
      description: (row.description as string) ?? null,
      definition,
      is_builtin: Boolean(row.is_builtin),
      created_at: row.created_at as string,
    };
  }

  async createScheduleTemplate(input: CreateScheduleTemplateInput): Promise<ScheduleTemplate> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO schedule_templates (name, description, definition_json, is_builtin)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
      [input.name, input.description || null, JSON.stringify(input.definition), 0]
    );
    const template = await this.getScheduleTemplateById(result.lastInsertId);
    if (!template) throw new Error('Failed to retrieve created template');
    return template;
  }

  async getScheduleTemplateById(id: number): Promise<ScheduleTemplate | null> {
    const row = await this.rawQueryOne<Record<string, unknown> & { is_builtin: number }>(
      `SELECT * FROM schedule_templates WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!row) return null;
    return this.scheduleTemplateRowToObj(row);
  }

  async getAllScheduleTemplates(): Promise<ScheduleTemplate[]> {
    const rows = await this.rawQuery<Record<string, unknown> & { is_builtin: number }>(
      `SELECT * FROM schedule_templates ORDER BY is_builtin DESC, name ASC`
    );
    return rows.map((r) => this.scheduleTemplateRowToObj(r));
  }

  async deleteScheduleTemplate(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM schedule_templates WHERE id = ${this.placeholder(1)}`, [id]);
  }

  // ── Client playlist operations ──────────────────────────────────────────

  async addClientPlaylist(
    clientId: string,
    playlistId: number,
    priority: number = 50
  ): Promise<ClientPlaylist> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_playlists (client_id, playlist_id, priority)
       VALUES (${p(1)}, ${p(2)}, ${p(3)})`,
      [clientId, playlistId, priority]
    );
    const row = await this.rawQueryOne<ClientPlaylist>(
      `SELECT * FROM client_playlists WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!row) throw new Error('Failed to retrieve created client playlist');
    return row;
  }

  async removeClientPlaylist(clientId: string, playlistId: number): Promise<void> {
    const p = this.placeholder;
    await this.rawExecute(
      `DELETE FROM client_playlists WHERE client_id = ${p(1)} AND playlist_id = ${p(2)}`,
      [clientId, playlistId]
    );
  }

  async getClientPlaylists(clientId: string): Promise<ClientPlaylistWithDetails[]> {
    const p = this.placeholder;
    return this.rawQuery<ClientPlaylistWithDetails>(
      `SELECT cp.*, p.name as playlist_name
       FROM client_playlists cp
       JOIN playlists p ON cp.playlist_id = p.id
       WHERE cp.client_id = ${p(1)}
       ORDER BY cp.priority DESC`,
      [clientId]
    );
  }

  async updateClientPlaylistPriority(
    clientId: string,
    playlistId: number,
    priority: number
  ): Promise<ClientPlaylist> {
    const p = this.placeholder;
    await this.rawExecute(
      `UPDATE client_playlists SET priority = ${p(1)}
       WHERE client_id = ${p(2)} AND playlist_id = ${p(3)}`,
      [priority, clientId, playlistId]
    );
    const row = await this.rawQueryOne<ClientPlaylist>(
      `SELECT * FROM client_playlists WHERE client_id = ${p(1)} AND playlist_id = ${p(2)}`,
      [clientId, playlistId]
    );
    if (!row) throw new Error('Client playlist assignment not found');
    return row;
  }

  // ── Playback log operations ─────────────────────────────────────────────

  async createPlaybackLog(input: CreatePlaybackLogInput): Promise<PlaybackLog> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO playback_logs (client_id, media_id, started_at, ended_at, duration_watched, completed)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
      [
        input.client_id,
        input.media_id,
        input.started_at || new Date().toISOString(),
        input.ended_at || null,
        input.duration_watched || 0,
        input.completed ? 1 : 0,
      ]
    );
    const log = await this.rawQueryOne<PlaybackLog>(
      `SELECT * FROM playback_logs WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!log) throw new Error('Failed to retrieve created playback log');
    return { ...log, completed: Boolean(log.completed) };
  }

  async updatePlaybackLog(
    id: number,
    updates: {
      ended_at?: string;
      duration_watched?: number;
      completed?: boolean;
      rebuffer_count?: number;
      dropped_frames?: number;
      time_to_first_frame_ms?: number;
      decoder_errors?: number;
    }
  ): Promise<PlaybackLog> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.ended_at !== undefined) {
      fields.push(`ended_at = ${this.placeholder(paramIndex++)}`);
      values.push(updates.ended_at);
    }
    if (updates.duration_watched !== undefined) {
      fields.push(`duration_watched = ${this.placeholder(paramIndex++)}`);
      values.push(updates.duration_watched);
    }
    if (updates.completed !== undefined) {
      fields.push(`completed = ${this.placeholder(paramIndex++)}`);
      values.push(updates.completed ? 1 : 0);
    }
    if (updates.rebuffer_count !== undefined) {
      fields.push(`rebuffer_count = ${this.placeholder(paramIndex++)}`);
      values.push(updates.rebuffer_count);
    }
    if (updates.dropped_frames !== undefined) {
      fields.push(`dropped_frames = ${this.placeholder(paramIndex++)}`);
      values.push(updates.dropped_frames);
    }
    if (updates.time_to_first_frame_ms !== undefined) {
      fields.push(`time_to_first_frame_ms = ${this.placeholder(paramIndex++)}`);
      values.push(updates.time_to_first_frame_ms);
    }
    if (updates.decoder_errors !== undefined) {
      fields.push(`decoder_errors = ${this.placeholder(paramIndex++)}`);
      values.push(updates.decoder_errors);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE playback_logs SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
        values
      );
    }

    const log = await this.rawQueryOne<PlaybackLog>(
      `SELECT * FROM playback_logs WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!log) throw new Error(`Playback log with ID ${id} not found`);
    return { ...log, completed: Boolean(log.completed) };
  }

  async getPlaybackLogs(filter?: {
    client_id?: string;
    media_id?: number;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<PlaybackLog[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filter?.client_id) {
      conditions.push(`client_id = ${this.placeholder(paramIndex++)}`);
      values.push(filter.client_id);
    }
    if (filter?.media_id) {
      conditions.push(`media_id = ${this.placeholder(paramIndex++)}`);
      values.push(filter.media_id);
    }
    if (filter?.from) {
      conditions.push(`started_at >= ${this.placeholder(paramIndex++)}`);
      values.push(filter.from);
    }
    if (filter?.to) {
      conditions.push(`started_at <= ${this.placeholder(paramIndex++)}`);
      values.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit || 100;

    const rows = await this.rawQuery<PlaybackLog>(
      `SELECT * FROM playback_logs ${where} ORDER BY started_at DESC LIMIT ${limit}`,
      values
    );
    return rows.map((r) => ({ ...r, completed: Boolean(r.completed) }));
  }

  async getPlaybackSummaryByClient(from?: string, to?: string): Promise<PlaybackSummary[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (from) {
      conditions.push(`pl.started_at >= ${this.placeholder(paramIndex++)}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`pl.started_at <= ${this.placeholder(paramIndex++)}`);
      values.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return this.rawQuery<PlaybackSummary>(
      `SELECT pl.client_id, c.name as client_name,
              SUM(pl.duration_watched) as total_duration,
              COUNT(pl.id) as total_plays
       FROM playback_logs pl
       JOIN clients c ON pl.client_id = c.id
       ${where}
       GROUP BY pl.client_id, c.name
       ORDER BY total_duration DESC`,
      values
    );
  }

  async getMediaPopularity(limit: number = 20): Promise<MediaPopularity[]> {
    return this.rawQuery<MediaPopularity>(
      `SELECT pl.media_id, mf.filename, mf.original_filename, mf.type,
              COUNT(pl.id) as play_count,
              SUM(pl.duration_watched) as total_duration
       FROM playback_logs pl
       JOIN media_files mf ON pl.media_id = mf.id
       GROUP BY pl.media_id, mf.filename, mf.original_filename, mf.type
       ORDER BY play_count DESC
       LIMIT ${limit}`
    );
  }

  async getClientUptimeStats(): Promise<UptimeStat[]> {
    return this.rawQuery<UptimeStat>(
      `SELECT c.id as client_id, c.name as client_name, c.status, c.last_seen,
              COUNT(pl.id) as total_logs
       FROM clients c
       LEFT JOIN playback_logs pl ON c.id = pl.client_id
       GROUP BY c.id, c.name, c.status, c.last_seen
       ORDER BY c.name ASC`
    );
  }

  async deleteOldPlaybackLogs(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await this.rawExecute(
      `DELETE FROM playback_logs WHERE started_at < ${this.placeholder(1)}`,
      [cutoff.toISOString()]
    );
    return result.affectedRows;
  }

  // ── Notification operations ─────────────────────────────────────────────

  async createNotificationRule(input: CreateNotificationRuleInput): Promise<NotificationRule> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO notification_rules (name, event_type, channel, destination, enabled)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`,
      [
        input.name,
        input.event_type,
        input.channel,
        input.destination,
        input.enabled !== false ? 1 : 0,
      ]
    );
    const rule = await this.getNotificationRuleById(result.lastInsertId);
    if (!rule) throw new Error('Failed to retrieve created notification rule');
    return rule;
  }

  async getNotificationRuleById(id: number): Promise<NotificationRule | null> {
    const row = await this.rawQueryOne<Omit<NotificationRule, 'enabled'> & { enabled: number }>(
      `SELECT * FROM notification_rules WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled) };
  }

  async getAllNotificationRules(): Promise<NotificationRule[]> {
    const rows = await this.rawQuery<Omit<NotificationRule, 'enabled'> & { enabled: number }>(
      'SELECT * FROM notification_rules ORDER BY created_at DESC'
    );
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  async getEnabledRulesForEvent(eventType: NotificationEventType): Promise<NotificationRule[]> {
    const rows = await this.rawQuery<Omit<NotificationRule, 'enabled'> & { enabled: number }>(
      `SELECT * FROM notification_rules WHERE event_type = ${this.placeholder(1)} AND enabled = 1`,
      [eventType]
    );
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  async deleteNotificationRule(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM notification_rules WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async createNotificationHistory(
    entry: Omit<NotificationHistory, 'id' | 'sent_at'>
  ): Promise<NotificationHistory> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO notification_history (rule_id, event_type, channel, destination, payload, status, error_message)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})`,
      [
        entry.rule_id,
        entry.event_type,
        entry.channel,
        entry.destination,
        entry.payload,
        entry.status,
        entry.error_message || null,
      ]
    );
    const row = await this.rawQueryOne<NotificationHistory>(
      `SELECT * FROM notification_history WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!row) throw new Error('Failed to retrieve created notification history');
    return row;
  }

  async getNotificationHistory(limit: number = 50): Promise<NotificationHistory[]> {
    return this.rawQuery<NotificationHistory>(
      `SELECT * FROM notification_history ORDER BY sent_at DESC LIMIT ${limit}`
    );
  }

  // ── Approval operations ─────────────────────────────────────────────────

  async updateMediaApproval(mediaId: number, status: ApprovalStatus): Promise<MediaFile> {
    return this.updateMedia(mediaId, { approval_status: status } as Partial<CreateMediaInput>);
  }

  async createApprovalLog(
    mediaId: number,
    action: ApprovalStatus,
    comment?: string
  ): Promise<ApprovalLog> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO approval_logs (media_id, action, comment) VALUES (${p(1)}, ${p(2)}, ${p(3)})`,
      [mediaId, action, comment || null]
    );
    const log = await this.rawQueryOne<ApprovalLog>(
      `SELECT * FROM approval_logs WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!log) throw new Error('Failed to retrieve created approval log');
    return log;
  }

  async getApprovalLogs(mediaId: number): Promise<ApprovalLog[]> {
    return this.rawQuery<ApprovalLog>(
      `SELECT * FROM approval_logs WHERE media_id = ${this.placeholder(1)} ORDER BY timestamp DESC`,
      [mediaId]
    );
  }

  async getPendingMedia(): Promise<MediaFile[]> {
    return this.rawQuery<MediaFile>(
      `SELECT * FROM media_files WHERE approval_status = 'pending' ORDER BY created_at DESC`
    );
  }

  // ── User operations ─────────────────────────────────────────────────────

  async createUser(input: CreateUserInput): Promise<User> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
      [input.username, input.email, input.password_hash, input.role || 'viewer']
    );
    const user = await this.getUserById(result.lastInsertId);
    if (!user) throw new Error('Failed to retrieve created user');
    return user;
  }

  async getUserById(id: number): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE username = ${this.placeholder(1)}`, [
      username,
    ]);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE email = ${this.placeholder(1)}`, [
      email,
    ]);
  }

  async getUserByEntraOid(entraOid: string): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE entra_oid = ${this.placeholder(1)}`, [
      entraOid,
    ]);
  }

  async setUserEntraOid(id: number, entraOid: string): Promise<void> {
    await this.rawExecute(
      `UPDATE users SET entra_oid = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
      [entraOid, id]
    );
  }

  async getAllUsers(): Promise<User[]> {
    return this.rawQuery<User>('SELECT * FROM users ORDER BY created_at DESC');
  }

  async deleteUser(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM users WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async updateUserPassword(id: number, passwordHash: string): Promise<void> {
    await this.rawExecute(
      `UPDATE users SET password_hash = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
      [passwordHash, id]
    );
  }

  async updateUser(id: number, input: UpdateUserInput): Promise<User> {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (input.email !== undefined) {
      fields.push(`email = ${this.placeholder(fields.length + 1)}`);
      values.push(input.email);
    }
    if (input.role !== undefined) {
      fields.push(`role = ${this.placeholder(fields.length + 1)}`);
      values.push(input.role);
    }
    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE users SET ${fields.join(', ')} WHERE id = ${this.placeholder(values.length)}`,
        values
      );
    }
    const user = await this.getUserById(id);
    if (!user) throw new Error(`User ${id} not found after update`);
    return user;
  }

  async getUserCount(): Promise<number> {
    const row = await this.rawQueryOne<{ count: number }>('SELECT COUNT(*) as count FROM users');
    return row?.count || 0;
  }

  // ── Client telemetry operations ─────────────────────────────────────────

  /**
   * Format an epoch-ms timestamp as `"YYYY-MM-DD HH:MM:SS"` (UTC).
   *
   * The `recorded_at` column is `DATETIME DEFAULT CURRENT_TIMESTAMP`, which in
   * SQLite stores TEXT with a space separator (no `T`, no `Z`). SQLite compares
   * those TEXT values lexicographically, so an ISO-`T`-`Z` filter string would
   * sort above stored values on the same calendar day and filter out real rows.
   * This format matches what `CURRENT_TIMESTAMP` emits and is also accepted by
   * MySQL and MSSQL as a DATETIME literal.
   */
  private toSqlDateTime(ms: number): string {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  }

  private hydrateTelemetryRow(
    row: Record<string, unknown> & { id: number; client_id: string; recorded_at: string }
  ): ClientTelemetryRow {
    return {
      id: row.id,
      client_id: row.client_id,
      cpu_pct: Number(row.cpu_pct),
      mem_used_mb: Number(row.mem_used_mb),
      mem_total_mb: Number(row.mem_total_mb),
      disks: JSON.parse(String(row.disks_json)) as TelemetryDiskSample[],
      temps: JSON.parse(String(row.temps_json)) as TelemetryTempSample[],
      net: JSON.parse(String(row.net_json)) as TelemetryNetSample,
      mpv: JSON.parse(String(row.mpv_json)) as TelemetryMpvSample,
      process: JSON.parse(String(row.process_json)) as TelemetryProcessSample,
      recorded_at: row.recorded_at,
    };
  }

  async recordClientTelemetry(input: CreateClientTelemetryInput): Promise<ClientTelemetryRow> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_telemetry (
        client_id, cpu_pct, mem_used_mb, mem_total_mb,
        disks_json, temps_json, net_json, mpv_json, process_json
      ) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)})`,
      [
        input.client_id,
        input.cpu_pct,
        input.mem_used_mb,
        input.mem_total_mb,
        JSON.stringify(input.disks),
        JSON.stringify(input.temps),
        JSON.stringify(input.net),
        JSON.stringify(input.mpv),
        JSON.stringify(input.process),
      ]
    );
    const row = await this.rawQueryOne<
      Record<string, unknown> & { id: number; client_id: string; recorded_at: string }
    >(`SELECT * FROM client_telemetry WHERE id = ${p(1)}`, [result.lastInsertId]);
    if (!row) throw new Error('Failed to retrieve created telemetry row');
    return this.hydrateTelemetryRow(row);
  }

  async getClientTelemetryRange(
    clientId: string,
    fromMs: number,
    toMs: number,
    limit: number = 1000
  ): Promise<ClientTelemetryRow[]> {
    const p = this.placeholder;
    const fromStr = this.toSqlDateTime(fromMs);
    const toStr = this.toSqlDateTime(toMs);
    const rows = await this.rawQuery<
      Record<string, unknown> & { id: number; client_id: string; recorded_at: string }
    >(
      `SELECT * FROM client_telemetry
       WHERE client_id = ${p(1)} AND recorded_at >= ${p(2)} AND recorded_at <= ${p(3)}
       ORDER BY recorded_at ASC
       LIMIT ${limit}`,
      [clientId, fromStr, toStr]
    );
    return rows.map((r) => this.hydrateTelemetryRow(r));
  }

  async getClientTelemetryLatest(clientId: string): Promise<ClientTelemetryRow | null> {
    const row = await this.rawQueryOne<
      Record<string, unknown> & { id: number; client_id: string; recorded_at: string }
    >(
      `SELECT * FROM client_telemetry
       WHERE client_id = ${this.placeholder(1)}
       ORDER BY recorded_at DESC
       LIMIT 1`,
      [clientId]
    );
    return row ? this.hydrateTelemetryRow(row) : null;
  }

  async getAllClientTelemetryLatest(): Promise<Record<string, ClientTelemetryRow>> {
    const rows = await this.rawQuery<
      Record<string, unknown> & { id: number; client_id: string; recorded_at: string; rn: number }
    >(
      `SELECT * FROM (
        SELECT t.*, ROW_NUMBER() OVER (PARTITION BY client_id ORDER BY recorded_at DESC) AS rn
        FROM client_telemetry t
      ) ranked WHERE rn = 1`
    );
    const out: Record<string, ClientTelemetryRow> = {};
    for (const row of rows) {
      out[row.client_id] = this.hydrateTelemetryRow(row);
    }
    return out;
  }

  async recordClientLogEvent(input: CreateClientLogEventInput): Promise<ClientLogEventRow> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_log_events (client_id, level, target, message)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
      [input.client_id, input.level, input.target, input.message]
    );
    const row = await this.rawQueryOne<ClientLogEventRow>(
      `SELECT * FROM client_log_events WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!row) throw new Error('Failed to retrieve created log event');
    return row;
  }

  async getClientLogEvents(
    clientId: string,
    level?: ClientLogLevel,
    limit: number = 100
  ): Promise<ClientLogEventRow[]> {
    const conditions: string[] = [`client_id = ${this.placeholder(1)}`];
    const values: unknown[] = [clientId];
    if (level) {
      conditions.push(`level = ${this.placeholder(2)}`);
      values.push(level);
    }
    return this.rawQuery<ClientLogEventRow>(
      `SELECT * FROM client_log_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC
       LIMIT ${limit}`,
      values
    );
  }

  async deleteOldClientTelemetry(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.rawExecute(
      `DELETE FROM client_telemetry WHERE recorded_at < ${this.placeholder(1)}`,
      [this.toSqlDateTime(cutoff.getTime())]
    );
    return result.affectedRows;
  }

  async deleteOldClientLogEvents(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.rawExecute(
      `DELETE FROM client_log_events WHERE recorded_at < ${this.placeholder(1)}`,
      [this.toSqlDateTime(cutoff.getTime())]
    );
    return result.affectedRows;
  }
}
