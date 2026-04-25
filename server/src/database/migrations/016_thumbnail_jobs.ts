/**
 * Migration 016: Thumbnail job queue
 *
 * A SQLite-backed queue for thumbnail generation. Replaces the
 * fire-and-forget promise pattern in media.service.ts — jobs now survive
 * crashes, restarts, and OOM kills. On startup, rows stuck at
 * state='running' are flipped back to 'queued' so nothing is ever lost.
 *
 * - `queued`: waiting for the poller to pick it up
 * - `running`: currently being processed by a worker
 * - `done`:    completed successfully
 * - `failed`:  exhausted retries (or permanent error)
 */

import { Migration, MigrationContext } from './types';

const SQL_UP_SQLITE = [
  `CREATE TABLE IF NOT EXISTS thumbnail_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_thumbnail_jobs_state ON thumbnail_jobs(state)`,
  `CREATE INDEX IF NOT EXISTS idx_thumbnail_jobs_media_id ON thumbnail_jobs(media_id)`,
];

const SQL_UP_MYSQL = [
  `CREATE TABLE IF NOT EXISTS thumbnail_jobs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    media_id INT NOT NULL,
    state VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    INDEX idx_thumbnail_jobs_state (state),
    INDEX idx_thumbnail_jobs_media_id (media_id)
  )`,
];

const SQL_UP_MSSQL = [
  `CREATE TABLE thumbnail_jobs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    media_id INT NOT NULL,
    state NVARCHAR(16) NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','done','failed')),
    attempts INT NOT NULL DEFAULT 0,
    last_error NVARCHAR(MAX),
    created_at DATETIME2 DEFAULT GETUTCDATE(),
    updated_at DATETIME2 DEFAULT GETUTCDATE(),
    CONSTRAINT FK_thumbnail_jobs_media FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_thumbnail_jobs_state ON thumbnail_jobs(state)`,
  `CREATE INDEX idx_thumbnail_jobs_media_id ON thumbnail_jobs(media_id)`,
];

export const migration: Migration = {
  version: '2.3.0',
  description: 'Add thumbnail_jobs queue table',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      const col = db.collection('thumbnail_jobs');
      await col.createIndex({ state: 1 });
      await col.createIndex({ media_id: 1 });
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
        .collection('thumbnail_jobs')
        .drop()
        .catch(() => {});
      return;
    }
    await ctx.executeSql!('DROP TABLE IF EXISTS thumbnail_jobs');
  },
};
