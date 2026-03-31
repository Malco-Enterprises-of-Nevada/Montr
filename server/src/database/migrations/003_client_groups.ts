/**
 * Migration 003: Add client_groups and client_group_members tables
 * Enables grouping clients for batch playlist assignment and scheduling.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS client_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE(group_id, client_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_client_group_members_group ON client_group_members(group_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_group_members_client ON client_group_members(client_id)`,
  `CREATE TRIGGER IF NOT EXISTS update_client_groups_timestamp
   AFTER UPDATE ON client_groups
   BEGIN
     UPDATE client_groups SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_groups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS client_group_members (
    id INT AUTO_INCREMENT PRIMARY KEY,
    group_id INT NOT NULL,
    client_id VARCHAR(36) NOT NULL,
    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    UNIQUE KEY uq_group_client (group_id, client_id)
  )`,
  `CREATE INDEX idx_client_group_members_group ON client_group_members(group_id)`,
  `CREATE INDEX idx_client_group_members_client ON client_group_members(client_id)`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE client_groups (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    description NVARCHAR(MAX),
    created_at DATETIME2 DEFAULT GETDATE(),
    updated_at DATETIME2 DEFAULT GETDATE()
  )`,
  `CREATE TABLE client_group_members (
    id INT IDENTITY(1,1) PRIMARY KEY,
    group_id INT NOT NULL,
    client_id NVARCHAR(36) NOT NULL,
    added_at DATETIME2 DEFAULT GETDATE(),
    CONSTRAINT FK_cgm_group FOREIGN KEY (group_id) REFERENCES client_groups(id) ON DELETE CASCADE,
    CONSTRAINT FK_cgm_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    CONSTRAINT UQ_group_client UNIQUE (group_id, client_id)
  )`,
  `CREATE INDEX idx_client_group_members_group ON client_group_members(group_id)`,
  `CREATE INDEX idx_client_group_members_client ON client_group_members(client_id)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.2.0',
  description: 'Add client_groups and client_group_members tables',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('client_groups');
      await db.createCollection('client_group_members');
      await db
        .collection('client_group_members')
        .createIndex({ group_id: 1, client_id: 1 }, { unique: true });
      // Initialize auto-increment counters
      await db
        .collection('counters')
        .updateOne(
          { _id: 'client_groups' as unknown as import('mongodb').ObjectId },
          { $setOnInsert: { seq: 0 } },
          { upsert: true }
        );
      await db
        .collection('counters')
        .updateOne(
          { _id: 'client_group_members' as unknown as import('mongodb').ObjectId },
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
        .collection('client_group_members')
        .drop()
        .catch(() => {});
      await db
        .collection('client_groups')
        .drop()
        .catch(() => {});
      return;
    }

    const dropStatements = [
      'DROP TABLE IF EXISTS client_group_members',
      'DROP TABLE IF EXISTS client_groups',
    ];

    if (ctx.adapterType === 'sqlite') {
      dropStatements.push('DROP TRIGGER IF EXISTS update_client_groups_timestamp');
    }

    await executeStatements(ctx, dropStatements);
  },
};
