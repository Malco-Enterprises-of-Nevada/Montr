/**
 * Migration 011: Add client_telemetry and client_log_events tables
 * Time-series storage for per-client system metrics (CPU, memory, disk, temps,
 * network, mpv health) and auto-pushed WARN/ERROR log lines.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    cpu_pct REAL NOT NULL,
    mem_used_mb INTEGER NOT NULL,
    mem_total_mb INTEGER NOT NULL,
    disks_json TEXT NOT NULL,
    temps_json TEXT NOT NULL,
    net_json TEXT NOT NULL,
    mpv_json TEXT NOT NULL,
    process_json TEXT NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS client_log_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('warn', 'error')),
    target TEXT NOT NULL,
    message TEXT NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_client_telemetry_client_recorded
    ON client_telemetry(client_id, recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_client_telemetry_recorded
    ON client_telemetry(recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_client_log_events_client_recorded
    ON client_log_events(client_id, recorded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_client_log_events_level_recorded
    ON client_log_events(level, recorded_at DESC)`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_telemetry (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(36) NOT NULL,
    cpu_pct DOUBLE NOT NULL,
    mem_used_mb BIGINT NOT NULL,
    mem_total_mb BIGINT NOT NULL,
    disks_json TEXT NOT NULL,
    temps_json TEXT NOT NULL,
    net_json TEXT NOT NULL,
    mpv_json TEXT NOT NULL,
    process_json TEXT NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS client_log_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(36) NOT NULL,
    level VARCHAR(8) NOT NULL,
    target VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_client_telemetry_client_recorded ON client_telemetry(client_id, recorded_at)`,
  `CREATE INDEX idx_client_telemetry_recorded ON client_telemetry(recorded_at)`,
  `CREATE INDEX idx_client_log_events_client_recorded ON client_log_events(client_id, recorded_at)`,
  `CREATE INDEX idx_client_log_events_level_recorded ON client_log_events(level, recorded_at)`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE client_telemetry (
    id INT IDENTITY(1,1) PRIMARY KEY,
    client_id NVARCHAR(36) NOT NULL,
    cpu_pct FLOAT NOT NULL,
    mem_used_mb BIGINT NOT NULL,
    mem_total_mb BIGINT NOT NULL,
    disks_json NVARCHAR(MAX) NOT NULL,
    temps_json NVARCHAR(MAX) NOT NULL,
    net_json NVARCHAR(MAX) NOT NULL,
    mpv_json NVARCHAR(MAX) NOT NULL,
    process_json NVARCHAR(MAX) NOT NULL,
    recorded_at DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_ct_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE client_log_events (
    id INT IDENTITY(1,1) PRIMARY KEY,
    client_id NVARCHAR(36) NOT NULL,
    level NVARCHAR(8) NOT NULL,
    target NVARCHAR(255) NOT NULL,
    message NVARCHAR(MAX) NOT NULL,
    recorded_at DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_cle_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX idx_client_telemetry_client_recorded ON client_telemetry(client_id, recorded_at)`,
  `CREATE INDEX idx_client_telemetry_recorded ON client_telemetry(recorded_at)`,
  `CREATE INDEX idx_client_log_events_client_recorded ON client_log_events(client_id, recorded_at)`,
  `CREATE INDEX idx_client_log_events_level_recorded ON client_log_events(level, recorded_at)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.10.0',
  description: 'Add client_telemetry and client_log_events tables',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('client_telemetry');
      await db.collection('client_telemetry').createIndex({ client_id: 1, recorded_at: -1 });
      await db.collection('client_telemetry').createIndex({ recorded_at: -1 });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'client_telemetry' as unknown as import('mongodb').ObjectId },
          { $setOnInsert: { seq: 0 } },
          { upsert: true }
        );

      await db.createCollection('client_log_events');
      await db.collection('client_log_events').createIndex({ client_id: 1, recorded_at: -1 });
      await db.collection('client_log_events').createIndex({ level: 1, recorded_at: -1 });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'client_log_events' as unknown as import('mongodb').ObjectId },
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
        .collection('client_telemetry')
        .drop()
        .catch(() => {});
      await db
        .collection('client_log_events')
        .drop()
        .catch(() => {});
      return;
    }

    await executeStatements(ctx, [
      'DROP TABLE IF EXISTS client_telemetry',
      'DROP TABLE IF EXISTS client_log_events',
    ]);
  },
};
