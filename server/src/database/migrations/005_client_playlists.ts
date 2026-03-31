/**
 * Migration 005: Add client_playlists junction table
 * Enables assigning multiple playlists to a client with priority.
 * The existing clients.assigned_playlist_id remains as the "active" playlist
 * (resolved from highest priority assignment).
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    playlist_id INTEGER NOT NULL,
    priority INTEGER DEFAULT 50,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    UNIQUE(client_id, playlist_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_client_playlists_client ON client_playlists(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_playlists_playlist ON client_playlists(playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_playlists_priority ON client_playlists(client_id, priority DESC)`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_playlists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(36) NOT NULL,
    playlist_id INT NOT NULL,
    priority INT DEFAULT 50,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    UNIQUE KEY uq_client_playlist (client_id, playlist_id)
  )`,
  `CREATE INDEX idx_client_playlists_client ON client_playlists(client_id)`,
  `CREATE INDEX idx_client_playlists_playlist ON client_playlists(playlist_id)`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE client_playlists (
    id INT IDENTITY(1,1) PRIMARY KEY,
    client_id NVARCHAR(36) NOT NULL,
    playlist_id INT NOT NULL,
    priority INT DEFAULT 50,
    assigned_at DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_cp_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT FK_cp_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT UQ_client_playlist UNIQUE (client_id, playlist_id)
  )`,
  `CREATE INDEX idx_client_playlists_client ON client_playlists(client_id)`,
  `CREATE INDEX idx_client_playlists_playlist ON client_playlists(playlist_id)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.4.0',
  description: 'Add client_playlists junction table for multiple playlist assignments',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('client_playlists');
      await db
        .collection('client_playlists')
        .createIndex({ client_id: 1, playlist_id: 1 }, { unique: true });
      await db.collection('client_playlists').createIndex({ client_id: 1, priority: -1 });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'client_playlists' as unknown as import('mongodb').ObjectId },
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
        .collection('client_playlists')
        .drop()
        .catch(() => {});
      return;
    }

    await executeStatements(ctx, ['DROP TABLE IF EXISTS client_playlists']);
  },
};
