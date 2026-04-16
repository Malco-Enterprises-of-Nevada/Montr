/**
 * Migration 014: media folders
 *
 * Adds a `media_folders` table (nested, self-referential) and a nullable
 * `folder_id` column to `media_files`. Existing media default to NULL,
 * which is treated as "root". Folders are a DB concept only — on-disk
 * storage layout and the `/api/media/:id/download` URL are unchanged,
 * so Rust clients are unaffected.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS media_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    parent_id INTEGER,
    path TEXT NOT NULL DEFAULT '/',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES media_folders(id) ON DELETE CASCADE,
    UNIQUE(parent_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_media_folders_parent ON media_folders(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_folders_path ON media_folders(path)`,
  `CREATE TRIGGER IF NOT EXISTS update_media_folders_timestamp
   AFTER UPDATE ON media_folders
   BEGIN
     UPDATE media_folders SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,
  `ALTER TABLE media_files ADD COLUMN folder_id INTEGER REFERENCES media_folders(id) ON DELETE SET NULL`,
  `CREATE INDEX IF NOT EXISTS idx_media_folder ON media_files(folder_id)`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS media_folders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    parent_id INT NULL,
    path VARCHAR(1024) NOT NULL DEFAULT '/',
    created_by INT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (parent_id) REFERENCES media_folders(id) ON DELETE CASCADE,
    UNIQUE KEY uq_folder_parent_name (parent_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE INDEX idx_media_folders_parent ON media_folders(parent_id)`,
  `CREATE INDEX idx_media_folders_path ON media_folders(path)`,
  `CREATE TRIGGER update_media_folders_timestamp
   AFTER UPDATE ON media_folders
   FOR EACH ROW
   UPDATE media_folders SET updated_at = NOW() WHERE id = NEW.id`,
  `ALTER TABLE media_files ADD COLUMN folder_id INT NULL`,
  `ALTER TABLE media_files ADD CONSTRAINT fk_media_folder FOREIGN KEY (folder_id) REFERENCES media_folders(id) ON DELETE SET NULL`,
  `CREATE INDEX idx_media_folder ON media_files(folder_id)`,
];

const MSSQL_STATEMENTS = [
  `IF OBJECT_ID('media_folders', 'U') IS NULL
   CREATE TABLE media_folders (
     id INT IDENTITY(1,1) PRIMARY KEY,
     name NVARCHAR(255) NOT NULL,
     parent_id INT NULL,
     path NVARCHAR(1024) NOT NULL DEFAULT '/',
     created_by INT NULL,
     created_at DATETIME2 DEFAULT GETUTCDATE(),
     updated_at DATETIME2 DEFAULT GETUTCDATE(),
     FOREIGN KEY (parent_id) REFERENCES media_folders(id),
     CONSTRAINT uq_folder_parent_name UNIQUE(parent_id, name)
   )`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_media_folders_parent')
   CREATE INDEX idx_media_folders_parent ON media_folders(parent_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_media_folders_path')
   CREATE INDEX idx_media_folders_path ON media_folders(path)`,
  `CREATE OR ALTER TRIGGER update_media_folders_timestamp ON media_folders
   AFTER UPDATE AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE media_folders SET updated_at = GETUTCDATE()
     FROM media_folders INNER JOIN inserted ON media_folders.id = inserted.id;
   END`,
  `IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'folder_id' AND Object_ID = Object_ID('media_files'))
   ALTER TABLE media_files ADD folder_id INT NULL`,
  `IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_media_folder')
   ALTER TABLE media_files ADD CONSTRAINT fk_media_folder FOREIGN KEY (folder_id) REFERENCES media_folders(id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_media_folder')
   CREATE INDEX idx_media_folder ON media_files(folder_id)`,
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

  if (!existing.has('media_folders')) {
    await db.createCollection('media_folders');
  }

  await db.collection('media_folders').createIndex({ parent_id: 1 });
  await db.collection('media_folders').createIndex({ path: 1 });
  // Enforce unique (parent_id, name) — sparse to allow NULL parent_id roots
  await db.collection('media_folders').createIndex({ parent_id: 1, name: 1 }, { unique: true });
  // Index on media_files.folder_id for filtering
  await db.collection('media_files').createIndex({ folder_id: 1 });

  // Auto-increment counter
  await db
    .collection('counters')
    .updateOne(
      { _id: 'media_folders' as unknown as import('mongodb').ObjectId },
      { $setOnInsert: { seq: 0 } },
      { upsert: true }
    );
}

async function teardownMongoDB(ctx: MigrationContext): Promise<void> {
  const db = ctx.getMongoDb!();
  await db
    .collection('media_folders')
    .drop()
    .catch(() => undefined);
  await db
    .collection('media_files')
    .updateMany({ folder_id: { $exists: true } }, { $unset: { folder_id: '' } })
    .catch(() => undefined);
}

export const migration: Migration = {
  version: '2.1.0',
  description: 'Media folders: nested organization for the media library',

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

    // SQL adapters: drop dependent index/column first, then the table.
    // SQLite can't drop columns in older versions, but 3.35+ (which
    // better-sqlite3 ships) supports ALTER TABLE DROP COLUMN.
    const statements: string[] = [];
    if (ctx.adapterType === 'sqlite') {
      statements.push('DROP INDEX IF EXISTS idx_media_folder');
      statements.push('ALTER TABLE media_files DROP COLUMN folder_id');
    } else if (ctx.adapterType === 'mysql') {
      statements.push('DROP INDEX idx_media_folder ON media_files');
      statements.push('ALTER TABLE media_files DROP FOREIGN KEY fk_media_folder');
      statements.push('ALTER TABLE media_files DROP COLUMN folder_id');
    } else if (ctx.adapterType === 'mssql') {
      statements.push(
        `IF EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_media_folder') DROP INDEX idx_media_folder ON media_files`
      );
      statements.push(
        `IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk_media_folder') ALTER TABLE media_files DROP CONSTRAINT fk_media_folder`
      );
      statements.push(
        `IF EXISTS (SELECT 1 FROM sys.columns WHERE Name = 'folder_id' AND Object_ID = Object_ID('media_files')) ALTER TABLE media_files DROP COLUMN folder_id`
      );
    }
    statements.push('DROP TABLE IF EXISTS media_folders');
    await executeStatements(ctx, statements);
  },
};
