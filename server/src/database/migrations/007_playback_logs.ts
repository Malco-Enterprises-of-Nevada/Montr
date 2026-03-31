/**
 * Migration 007: Add playback_logs table
 * Tracks media playback events for analytics and reporting.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS playback_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    media_id INTEGER NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    duration_watched REAL DEFAULT 0,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_playback_logs_client ON playback_logs(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_playback_logs_media ON playback_logs(media_id)`,
  `CREATE INDEX IF NOT EXISTS idx_playback_logs_started ON playback_logs(started_at DESC)`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS playback_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(36) NOT NULL,
    media_id INT NOT NULL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    duration_watched DOUBLE DEFAULT 0,
    completed TINYINT DEFAULT 0,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_playback_logs_client ON playback_logs(client_id)`,
  `CREATE INDEX idx_playback_logs_media ON playback_logs(media_id)`,
  `CREATE INDEX idx_playback_logs_started ON playback_logs(started_at)`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE playback_logs (
    id INT IDENTITY(1,1) PRIMARY KEY,
    client_id NVARCHAR(36) NOT NULL,
    media_id INT NOT NULL,
    started_at DATETIME2 DEFAULT GETDATE(),
    ended_at DATETIME2,
    duration_watched FLOAT DEFAULT 0,
    completed BIT DEFAULT 0,
    CONSTRAINT FK_pl_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT FK_pl_media FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_playback_logs_client ON playback_logs(client_id)`,
  `CREATE INDEX idx_playback_logs_media ON playback_logs(media_id)`,
  `CREATE INDEX idx_playback_logs_started ON playback_logs(started_at)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.6.0',
  description: 'Add playback_logs table for analytics',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('playback_logs');
      await db.collection('playback_logs').createIndex({ client_id: 1 });
      await db.collection('playback_logs').createIndex({ media_id: 1 });
      await db.collection('playback_logs').createIndex({ started_at: -1 });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'playback_logs' as unknown as import('mongodb').ObjectId },
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
        .collection('playback_logs')
        .drop()
        .catch(() => {});
      return;
    }

    await executeStatements(ctx, ['DROP TABLE IF EXISTS playback_logs']);
  },
};
