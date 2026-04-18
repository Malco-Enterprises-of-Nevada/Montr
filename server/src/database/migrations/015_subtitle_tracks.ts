/**
 * Migration 015: subtitle tracks
 *
 * Adds a `subtitle_tracks` table linking subtitle resources (external files
 * uploaded separately or streams embedded inside a video container) to a
 * parent row in `media_files`. ON DELETE CASCADE keeps the table in step
 * with its parent; external-only vs embedded-only fields are distinguished
 * by `kind`.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS subtitle_tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_file_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('external','embedded')),
    storage_filename TEXT,
    original_filename TEXT,
    format TEXT CHECK(format IN ('srt','vtt')),
    size_bytes INTEGER,
    checksum TEXT,
    stream_index INTEGER,
    codec TEXT,
    language TEXT,
    label TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    is_forced INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_subtitle_tracks_media ON subtitle_tracks(media_file_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_subtitle_tracks_embedded
    ON subtitle_tracks(media_file_id, stream_index)
    WHERE kind = 'embedded'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_subtitle_tracks_external
    ON subtitle_tracks(media_file_id, storage_filename)
    WHERE kind = 'external'`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS subtitle_tracks (
    id INT AUTO_INCREMENT PRIMARY KEY,
    media_file_id INT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    storage_filename VARCHAR(512) NULL,
    original_filename VARCHAR(512) NULL,
    format VARCHAR(8) NULL,
    size_bytes BIGINT NULL,
    checksum VARCHAR(128) NULL,
    stream_index INT NULL,
    codec VARCHAR(64) NULL,
    language VARCHAR(16) NULL,
    label VARCHAR(255) NULL,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    is_forced TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE CASCADE,
    CHECK (kind IN ('external','embedded'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE INDEX idx_subtitle_tracks_media ON subtitle_tracks(media_file_id)`,
];

const MSSQL_STATEMENTS = [
  `IF OBJECT_ID('subtitle_tracks', 'U') IS NULL
   CREATE TABLE subtitle_tracks (
     id INT IDENTITY(1,1) PRIMARY KEY,
     media_file_id INT NOT NULL,
     kind NVARCHAR(16) NOT NULL CHECK (kind IN ('external','embedded')),
     storage_filename NVARCHAR(512) NULL,
     original_filename NVARCHAR(512) NULL,
     format NVARCHAR(8) NULL,
     size_bytes BIGINT NULL,
     checksum NVARCHAR(128) NULL,
     stream_index INT NULL,
     codec NVARCHAR(64) NULL,
     language NVARCHAR(16) NULL,
     label NVARCHAR(255) NULL,
     is_default BIT NOT NULL DEFAULT 0,
     is_forced BIT NOT NULL DEFAULT 0,
     created_at DATETIME2 DEFAULT GETUTCDATE(),
     CONSTRAINT fk_subtitle_media FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE CASCADE
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_subtitle_tracks_media')
   CREATE INDEX idx_subtitle_tracks_media ON subtitle_tracks(media_file_id)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

async function setupMongoDB(ctx: MigrationContext): Promise<void> {
  const db = ctx.getMongoDb!();
  const collections = await db.listCollections().toArray();
  const existing = new Set(collections.map((c) => c.name));

  if (!existing.has('subtitle_tracks')) {
    await db.createCollection('subtitle_tracks');
  }

  await db.collection('subtitle_tracks').createIndex({ media_file_id: 1 });
  await db
    .collection('subtitle_tracks')
    .createIndex(
      { media_file_id: 1, stream_index: 1 },
      { unique: true, partialFilterExpression: { kind: 'embedded' } }
    );
  await db
    .collection('subtitle_tracks')
    .createIndex(
      { media_file_id: 1, storage_filename: 1 },
      { unique: true, partialFilterExpression: { kind: 'external' } }
    );

  await db
    .collection('counters')
    .updateOne(
      { _id: 'subtitle_tracks' as unknown as import('mongodb').ObjectId },
      { $setOnInsert: { seq: 0 } },
      { upsert: true }
    );
}

async function teardownMongoDB(ctx: MigrationContext): Promise<void> {
  const db = ctx.getMongoDb!();
  await db
    .collection('subtitle_tracks')
    .drop()
    .catch(() => undefined);
}

export const migration: Migration = {
  version: '2.2.0',
  description: 'Subtitle tracks: external sidecar files and embedded container streams',

  async up(ctx: MigrationContext): Promise<void> {
    switch (ctx.adapterType) {
      case 'sqlite':
        await executeStatements(ctx, SQLITE_STATEMENTS);
        break;
      case 'mysql':
        await executeStatements(ctx, MYSQL_STATEMENTS);
        break;
      case 'mssql':
        await executeStatements(ctx, MSSQL_STATEMENTS);
        break;
      case 'mongodb':
        await setupMongoDB(ctx);
        break;
      default:
        throw new Error(`Unsupported adapter type: ${ctx.adapterType}`);
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      await teardownMongoDB(ctx);
      return;
    }
    await executeStatements(ctx, ['DROP TABLE IF EXISTS subtitle_tracks']);
  },
};
