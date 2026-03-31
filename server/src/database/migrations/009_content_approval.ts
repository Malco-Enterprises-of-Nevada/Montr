/**
 * Migration 009: Add content approval workflow
 * Adds approval_status to media_files and approval_logs table.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `ALTER TABLE media_files ADD COLUMN approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected'))`,
  `CREATE TABLE IF NOT EXISTS approval_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('pending', 'approved', 'rejected')),
    comment TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approval_logs_media ON approval_logs(media_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_approval ON media_files(approval_status)`,
];

const MYSQL_STATEMENTS = [
  `ALTER TABLE media_files ADD COLUMN approval_status VARCHAR(10) DEFAULT 'pending'`,
  `CREATE TABLE IF NOT EXISTS approval_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    media_id INT NOT NULL,
    action VARCHAR(10) NOT NULL,
    comment TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_approval_logs_media ON approval_logs(media_id)`,
  `CREATE INDEX idx_media_approval ON media_files(approval_status)`,
];

const MSSQL_STATEMENTS = [
  `ALTER TABLE media_files ADD approval_status NVARCHAR(10) DEFAULT 'pending'`,
  `CREATE TABLE approval_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    media_id INT NOT NULL,
    action NVARCHAR(10) NOT NULL,
    comment NVARCHAR(MAX),
    timestamp DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_al_media FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_approval_logs_media ON approval_logs(media_id)`,
  `CREATE INDEX idx_media_approval ON media_files(approval_status)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.8.0',
  description: 'Add content approval workflow',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('media_files')
        .updateMany(
          { approval_status: { $exists: false } },
          { $set: { approval_status: 'pending' } }
        );
      await db.createCollection('approval_logs');
      await db.collection('approval_logs').createIndex({ media_id: 1 });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'approval_logs' as unknown as import('mongodb').ObjectId },
          { $setOnInsert: { seq: 0 } },
          { upsert: true }
        );
      return;
    }

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
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('approval_logs')
        .drop()
        .catch(() => {});
      await db.collection('media_files').updateMany({}, { $unset: { approval_status: '' } });
      return;
    }

    await executeStatements(ctx, ['DROP TABLE IF EXISTS approval_logs']);
    if (ctx.adapterType !== 'sqlite') {
      await ctx.executeSql!('ALTER TABLE media_files DROP COLUMN approval_status');
    }
  },
};
