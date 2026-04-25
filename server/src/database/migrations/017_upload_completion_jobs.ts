/**
 * Migration 017: Upload-completion job queue
 *
 * Moves the slow post-chunk work (SHA-256 download + ffprobe + dedup +
 * createMedia) out of the synchronous POST /api/media/upload/:id/complete
 * handler and into a SQLite-backed job queue. The HTTP request now only
 * finalises the S3 multipart upload (fast, <10 s) and persists a job row,
 * then returns 202 — unblocking 100 GB uploads that previously tripped
 * Cloudflare Free's 100 s origin timeout.
 *
 * Differences from 016 (thumbnail_jobs):
 *   - `upload_id` is UNIQUE so a retried /complete call is idempotent
 *     (INSERT OR IGNORE → same row, same jobId returned).
 *   - No FK to media_files: the media row doesn't exist until the job
 *     completes. When it does, `media_id` is populated.
 *   - Adds a `'duplicate'` terminal state with `existing_media_id` for
 *     content-hash dedup hits, replacing the old 409 throw path.
 *   - Carries the input payload (filename/mime/size/folder/storage_key)
 *     because the in-memory UploadSession is deleted on /complete and
 *     the worker needs all that context to do its job.
 */

import { Migration, MigrationContext } from './types';

const SQL_UP_SQLITE = [
  `CREATE TABLE IF NOT EXISTS upload_completion_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id TEXT NOT NULL UNIQUE,
    storage_backend TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    folder_id INTEGER,
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','duplicate','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    media_id INTEGER,
    existing_media_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_upload_completion_jobs_state ON upload_completion_jobs(state)`,
  `CREATE INDEX IF NOT EXISTS idx_upload_completion_jobs_upload_id ON upload_completion_jobs(upload_id)`,
];

const SQL_UP_MYSQL = [
  `CREATE TABLE IF NOT EXISTS upload_completion_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    upload_id VARCHAR(64) NOT NULL UNIQUE,
    storage_backend VARCHAR(16) NOT NULL,
    storage_key VARCHAR(512) NOT NULL,
    original_filename VARCHAR(512) NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    total_size BIGINT NOT NULL,
    folder_id INT,
    state VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    media_id INT,
    existing_media_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_upload_completion_jobs_state (state)
  )`,
];

const SQL_UP_MSSQL = [
  `CREATE TABLE upload_completion_jobs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    upload_id NVARCHAR(64) NOT NULL UNIQUE,
    storage_backend NVARCHAR(16) NOT NULL,
    storage_key NVARCHAR(512) NOT NULL,
    original_filename NVARCHAR(512) NOT NULL,
    mime_type NVARCHAR(128) NOT NULL,
    total_size BIGINT NOT NULL,
    folder_id INT,
    state NVARCHAR(16) NOT NULL DEFAULT 'queued'
      CHECK(state IN ('queued','running','done','duplicate','failed')),
    attempts INT NOT NULL DEFAULT 0,
    last_error NVARCHAR(MAX),
    media_id INT,
    existing_media_id INT,
    created_at DATETIME2 DEFAULT GETUTCDATE(),
    updated_at DATETIME2 DEFAULT GETUTCDATE()
  )`,
  `CREATE INDEX idx_upload_completion_jobs_state ON upload_completion_jobs(state)`,
  `CREATE INDEX idx_upload_completion_jobs_upload_id ON upload_completion_jobs(upload_id)`,
];

export const migration: Migration = {
  version: '2.4.0',
  description: 'Add upload_completion_jobs queue table',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      const col = db.collection('upload_completion_jobs');
      await col.createIndex({ state: 1 });
      await col.createIndex({ upload_id: 1 }, { unique: true });
      return;
    }

    const stmts =
      ctx.adapterType === 'sqlite'
        ? SQL_UP_SQLITE
        : ctx.adapterType === 'mssql'
          ? SQL_UP_MSSQL
          : SQL_UP_MYSQL;

    for (const stmt of stmts) {
      await ctx.executeSql!(stmt);
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('upload_completion_jobs')
        .drop()
        .catch(() => {});
      return;
    }
    await ctx.executeSql!('DROP TABLE IF EXISTS upload_completion_jobs');
  },
};
