/**
 * Migration 002: Add thumbnail_status column to media_files
 * Tracks the state of thumbnail generation (pending, generating, generated, failed).
 */

import { Migration, MigrationContext } from './types';

const SQL_UP = `ALTER TABLE media_files ADD COLUMN thumbnail_status TEXT DEFAULT 'pending' CHECK(thumbnail_status IN ('pending', 'generating', 'generated', 'failed'))`;
const SQL_DOWN_SQLITE = [
  `CREATE TABLE media_files_backup AS SELECT id, filename, original_filename, filepath, type, mime_type, file_size, duration, width, height, checksum, created_at, updated_at FROM media_files`,
  `DROP TABLE media_files`,
  `ALTER TABLE media_files_backup RENAME TO media_files`,
];

export const migration: Migration = {
  version: '1.1.0',
  description: 'Add thumbnail_status column to media_files',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('media_files')
        .updateMany(
          { thumbnail_status: { $exists: false } },
          { $set: { thumbnail_status: 'pending' } }
        );
      return;
    }

    if (ctx.adapterType === 'mssql') {
      await ctx.executeSql!(
        `ALTER TABLE media_files ADD thumbnail_status NVARCHAR(20) DEFAULT 'pending' CONSTRAINT CK_media_thumbnail_status CHECK(thumbnail_status IN ('pending', 'generating', 'generated', 'failed'))`
      );
      return;
    }

    // SQLite and MySQL
    await ctx.executeSql!(SQL_UP);
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.collection('media_files').updateMany({}, { $unset: { thumbnail_status: '' } });
      return;
    }

    if (ctx.adapterType === 'sqlite') {
      // SQLite doesn't support DROP COLUMN before 3.35.0, use table rebuild
      for (const stmt of SQL_DOWN_SQLITE) {
        await ctx.executeSql!(stmt);
      }
      return;
    }

    // MySQL / MSSQL
    if (ctx.adapterType === 'mssql') {
      await ctx.executeSql!('ALTER TABLE media_files DROP CONSTRAINT CK_media_thumbnail_status');
    }
    await ctx.executeSql!('ALTER TABLE media_files DROP COLUMN thumbnail_status');
  },
};
