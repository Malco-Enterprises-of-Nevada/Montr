/**
 * Migration 004: Add schedules table and loop column on playlists
 * Enables time-based playlist scheduling for clients and groups.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    playlist_id INTEGER NOT NULL,
    client_id TEXT,
    group_id INTEGER,
    start_time TEXT NOT NULL,
    end_time TEXT,
    days_of_week TEXT DEFAULT '0,1,2,3,4,5,6',
    priority INTEGER DEFAULT 50,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_playlist ON schedules(playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_client ON schedules(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)`,
  `CREATE TRIGGER IF NOT EXISTS update_schedules_timestamp
   AFTER UPDATE ON schedules
   BEGIN
     UPDATE schedules SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,
  `ALTER TABLE playlists ADD COLUMN loop INTEGER DEFAULT 1`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS schedules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    playlist_id INT NOT NULL,
    client_id VARCHAR(36),
    group_id INT,
    start_time VARCHAR(5) NOT NULL,
    end_time VARCHAR(5),
    days_of_week VARCHAR(20) DEFAULT '0,1,2,3,4,5,6',
    priority INT DEFAULT 50,
    enabled TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_schedules_playlist ON schedules(playlist_id)`,
  `CREATE INDEX idx_schedules_client ON schedules(client_id)`,
  `CREATE INDEX idx_schedules_group ON schedules(group_id)`,
  `CREATE INDEX idx_schedules_enabled ON schedules(enabled)`,
  `ALTER TABLE playlists ADD COLUMN loop TINYINT DEFAULT 1`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE schedules (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    playlist_id INT NOT NULL,
    client_id NVARCHAR(36),
    group_id INT,
    start_time NVARCHAR(5) NOT NULL,
    end_time NVARCHAR(5),
    days_of_week NVARCHAR(20) DEFAULT '0,1,2,3,4,5,6',
    priority INT DEFAULT 50,
    enabled BIT DEFAULT 1,
    created_at DATETIME2 DEFAULT GETDATE(),
    updated_at DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_sched_playlist FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    CONSTRAINT FK_sched_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT FK_sched_group FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE NO ACTION
  )`,
  `CREATE INDEX idx_schedules_playlist ON schedules(playlist_id)`,
  `CREATE INDEX idx_schedules_client ON schedules(client_id)`,
  `CREATE INDEX idx_schedules_group ON schedules(group_id)`,
  `CREATE INDEX idx_schedules_enabled ON schedules(enabled)`,
  `ALTER TABLE playlists ADD loop BIT DEFAULT 1`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.3.0',
  description: 'Add schedules table and loop column on playlists',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('schedules');
      await db.collection('schedules').createIndex({ enabled: 1 });
      await db.collection('schedules').createIndex({ playlist_id: 1 });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'schedules' as unknown as import('mongodb').ObjectId },
          { $setOnInsert: { seq: 0 } },
          { upsert: true }
        );
      // Add loop field to existing playlists
      await db
        .collection('playlists')
        .updateMany({ loop: { $exists: false } }, { $set: { loop: true } });
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
        .collection('schedules')
        .drop()
        .catch(() => {});
      await db.collection('playlists').updateMany({}, { $unset: { loop: '' } });
      return;
    }

    const dropStatements = ['DROP TABLE IF EXISTS schedules'];
    if (ctx.adapterType === 'sqlite') {
      dropStatements.push('DROP TRIGGER IF EXISTS update_schedules_timestamp');
    }
    // Note: SQLite < 3.35 can't DROP COLUMN; loop column left in place for simplicity
    await executeStatements(ctx, dropStatements);
  },
};
