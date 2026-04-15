/**
 * Migration 013: Advanced scheduling — cron expressions, conditions, templates
 *
 * Extends the schedules table with cron_expression, timezone, duration_seconds,
 * conditions (JSON), interrupt_mode, template_id. Adds schedule_templates table
 * with built-in presets seeded.
 */

import { Migration, MigrationContext } from './types';

const BUILTIN_TEMPLATES = [
  {
    name: 'Business hours (9-5 weekdays)',
    description: 'Triggers at 09:00 Monday–Friday, runs 8 hours',
    definition: {
      mode: 'advanced' as const,
      cron_expression: '0 9 * * 1-5',
      duration_seconds: 28800,
      interrupt_mode: 'assign' as const,
    },
  },
  {
    name: 'Weekends only',
    description: 'All day Saturday and Sunday',
    definition: {
      mode: 'simple' as const,
      start_time: '00:00',
      end_time: '23:59',
      days_of_week: '0,6',
      interrupt_mode: 'assign' as const,
    },
  },
  {
    name: 'Holiday hours',
    description: 'Plays only on public holidays',
    definition: {
      mode: 'advanced' as const,
      cron_expression: '0 10 * * *',
      duration_seconds: 21600,
      conditions: { holidays: { country: 'US', match: 'on' } },
      interrupt_mode: 'assign' as const,
    },
  },
  {
    name: 'Evenings & weekends',
    description: 'Triggers at 17:00 weekdays plus all day weekends',
    definition: {
      mode: 'advanced' as const,
      cron_expression: '0 17 * * 1-5',
      duration_seconds: 57600,
      interrupt_mode: 'assign' as const,
    },
  },
  {
    name: 'Offline emergency',
    description: 'Fires whenever a client_offline event is emitted',
    definition: {
      mode: 'advanced' as const,
      duration_seconds: 900,
      conditions: { event_trigger: { event_type: 'client_offline' } },
      interrupt_mode: 'interrupt' as const,
    },
  },
];

const SQLITE_STATEMENTS = [
  // Relax start_time NOT NULL so cron-only schedules don't need it.
  // SQLite lacks ALTER COLUMN — rebuild the table.
  `CREATE TABLE schedules_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    playlist_id INTEGER NOT NULL,
    client_id TEXT,
    group_id INTEGER,
    start_time TEXT,
    end_time TEXT,
    days_of_week TEXT DEFAULT '0,1,2,3,4,5,6',
    priority INTEGER DEFAULT 50,
    enabled INTEGER DEFAULT 1,
    cron_expression TEXT,
    duration_seconds INTEGER,
    timezone TEXT,
    conditions TEXT,
    interrupt_mode TEXT DEFAULT 'assign',
    template_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE CASCADE
  )`,
  `INSERT INTO schedules_new (id, name, playlist_id, client_id, group_id, start_time, end_time, days_of_week, priority, enabled, created_at, updated_at)
   SELECT id, name, playlist_id, client_id, group_id, start_time, end_time, days_of_week, priority, enabled, created_at, updated_at FROM schedules`,
  `DROP TABLE schedules`,
  `ALTER TABLE schedules_new RENAME TO schedules`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_playlist ON schedules(playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_client ON schedules(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_group ON schedules(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled)`,
  `CREATE TRIGGER IF NOT EXISTS update_schedules_timestamp
   AFTER UPDATE ON schedules
   BEGIN
     UPDATE schedules SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,
  `CREATE TABLE IF NOT EXISTS schedule_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    is_builtin INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
];

const MYSQL_STATEMENTS = [
  `ALTER TABLE schedules MODIFY COLUMN start_time VARCHAR(5) NULL`,
  `ALTER TABLE schedules ADD COLUMN cron_expression VARCHAR(128) NULL`,
  `ALTER TABLE schedules ADD COLUMN duration_seconds INT NULL`,
  `ALTER TABLE schedules ADD COLUMN timezone VARCHAR(64) NULL`,
  `ALTER TABLE schedules ADD COLUMN conditions TEXT NULL`,
  `ALTER TABLE schedules ADD COLUMN interrupt_mode VARCHAR(16) DEFAULT 'assign'`,
  `ALTER TABLE schedules ADD COLUMN template_id INT NULL`,
  `CREATE TABLE IF NOT EXISTS schedule_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    is_builtin TINYINT DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
];

const MSSQL_STATEMENTS = [
  `ALTER TABLE schedules ALTER COLUMN start_time NVARCHAR(5) NULL`,
  `ALTER TABLE schedules ADD cron_expression NVARCHAR(128) NULL`,
  `ALTER TABLE schedules ADD duration_seconds INT NULL`,
  `ALTER TABLE schedules ADD timezone NVARCHAR(64) NULL`,
  `ALTER TABLE schedules ADD conditions NVARCHAR(MAX) NULL`,
  `ALTER TABLE schedules ADD interrupt_mode NVARCHAR(16) DEFAULT 'assign'`,
  `ALTER TABLE schedules ADD template_id INT NULL`,
  `CREATE TABLE schedule_templates (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    description NVARCHAR(MAX),
    definition_json NVARCHAR(MAX) NOT NULL,
    is_builtin BIT DEFAULT 0,
    created_at DATETIME2 DEFAULT GETDATE()
  )`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

async function seedTemplatesSql(ctx: MigrationContext): Promise<void> {
  // Delete any pre-existing built-ins (idempotent seed), then insert.
  await ctx.executeSql!(`DELETE FROM schedule_templates WHERE is_builtin = 1`);
  for (const t of BUILTIN_TEMPLATES) {
    const placeholder =
      ctx.adapterType === 'mssql' ? ['@p1', '@p2', '@p3', '@p4'] : ['?', '?', '?', '?'];
    const isBuiltin = ctx.adapterType === 'mssql' ? 1 : 1;
    await ctx.executeSql!(
      `INSERT INTO schedule_templates (name, description, definition_json, is_builtin) VALUES (${placeholder[0]}, ${placeholder[1]}, ${placeholder[2]}, ${placeholder[3]})`,
      [t.name, t.description, JSON.stringify(t.definition), isBuiltin]
    );
  }
}

export const migration: Migration = {
  version: '2.0.0',
  description: 'Advanced scheduling: cron, conditions, templates',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('schedule_templates').catch(() => undefined);
      await db
        .collection('counters')
        .updateOne(
          { _id: 'schedule_templates' as unknown as import('mongodb').ObjectId },
          { $setOnInsert: { seq: 0 } },
          { upsert: true }
        );

      // Clear and reseed built-in templates
      await db.collection('schedule_templates').deleteMany({ is_builtin: true });
      const countersCol = db.collection('counters');
      let nextId = 1;
      for (const t of BUILTIN_TEMPLATES) {
        const res = await countersCol.findOneAndUpdate(
          { _id: 'schedule_templates' as unknown as import('mongodb').ObjectId },
          { $inc: { seq: 1 } },
          { returnDocument: 'after', upsert: true }
        );
        nextId = (res?.seq as number) ?? nextId;
        await db.collection('schedule_templates').insertOne({
          id: nextId,
          name: t.name,
          description: t.description,
          definition_json: JSON.stringify(t.definition),
          is_builtin: true,
          created_at: new Date().toISOString(),
        });
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
    await seedTemplatesSql(ctx);
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('schedule_templates')
        .drop()
        .catch(() => undefined);
      return;
    }
    await executeStatements(ctx, ['DROP TABLE IF EXISTS schedule_templates']);
    // schedule column additions not removed (SQLite can't drop columns easily;
    // other adapters left as-is for forward-compatibility).
  },
};
