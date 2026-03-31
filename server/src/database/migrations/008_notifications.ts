/**
 * Migration 008: Add notification_rules and notification_history tables
 * Enables configurable email/webhook notifications for system events.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notification_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('client_offline', 'client_error', 'playlist_empty', 'storage_full')),
    channel TEXT NOT NULL CHECK(channel IN ('email', 'webhook')),
    destination TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notification_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL,
    destination TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sent', 'failed')),
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notification_rules_event ON notification_rules(event_type, enabled)`,
  `CREATE INDEX IF NOT EXISTS idx_notification_history_sent ON notification_history(sent_at DESC)`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS notification_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    event_type VARCHAR(30) NOT NULL,
    channel VARCHAR(10) NOT NULL,
    destination TEXT NOT NULL,
    enabled TINYINT DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS notification_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    rule_id INT NOT NULL,
    event_type VARCHAR(30) NOT NULL,
    channel VARCHAR(10) NOT NULL,
    destination TEXT NOT NULL,
    payload TEXT NOT NULL,
    status VARCHAR(10) NOT NULL,
    error_message TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_notification_rules_event ON notification_rules(event_type, enabled)`,
  `CREATE INDEX idx_notification_history_sent ON notification_history(sent_at)`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE notification_rules (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    event_type NVARCHAR(30) NOT NULL,
    channel NVARCHAR(10) NOT NULL,
    destination NVARCHAR(MAX) NOT NULL,
    enabled BIT DEFAULT 1,
    created_at DATETIME2 DEFAULT GETDATE()
  )`,
  `CREATE TABLE notification_history (
    id INT IDENTITY(1,1) PRIMARY KEY,
    rule_id INT NOT NULL,
    event_type NVARCHAR(30) NOT NULL,
    channel NVARCHAR(10) NOT NULL,
    destination NVARCHAR(MAX) NOT NULL,
    payload NVARCHAR(MAX) NOT NULL,
    status NVARCHAR(10) NOT NULL,
    error_message NVARCHAR(MAX),
    sent_at DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_nh_rule FOREIGN KEY (rule_id) REFERENCES notification_rules(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_notification_rules_event ON notification_rules(event_type, enabled)`,
  `CREATE INDEX idx_notification_history_sent ON notification_history(sent_at)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.7.0',
  description: 'Add notification_rules and notification_history tables',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('notification_rules');
      await db.createCollection('notification_history');
      await db.collection('notification_rules').createIndex({ event_type: 1, enabled: 1 });
      await db.collection('notification_history').createIndex({ sent_at: -1 });
      for (const col of ['notification_rules', 'notification_history']) {
        await db
          .collection('counters')
          .updateOne(
            { _id: col as unknown as import('mongodb').ObjectId },
            { $setOnInsert: { seq: 0 } },
            { upsert: true }
          );
      }
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
        .collection('notification_history')
        .drop()
        .catch(() => {});
      await db
        .collection('notification_rules')
        .drop()
        .catch(() => {});
      return;
    }

    await executeStatements(ctx, [
      'DROP TABLE IF EXISTS notification_history',
      'DROP TABLE IF EXISTS notification_rules',
    ]);
  },
};
