/**
 * Migration 012: Widen notification_rules.event_type CHECK constraint
 * Adds 'media_approval_needed' to the allowed event types for SQLite.
 * MySQL, MSSQL, and MongoDB have no enumerated constraint on this column.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_REBUILD = [
  `CREATE TABLE notification_rules_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('client_offline', 'client_error', 'playlist_empty', 'storage_full', 'media_approval_needed')),
    channel TEXT NOT NULL CHECK(channel IN ('email', 'webhook')),
    destination TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `INSERT INTO notification_rules_new (id, name, event_type, channel, destination, enabled, created_at)
   SELECT id, name, event_type, channel, destination, enabled, created_at FROM notification_rules`,
  `DROP TABLE notification_rules`,
  `ALTER TABLE notification_rules_new RENAME TO notification_rules`,
  `CREATE INDEX IF NOT EXISTS idx_notification_rules_event ON notification_rules(event_type, enabled)`,
];

export const migration: Migration = {
  version: '1.11.0',
  description: 'Widen notification event_type to include media_approval_needed',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'sqlite') {
      for (const stmt of SQLITE_REBUILD) {
        await ctx.executeSql!(stmt);
      }
    }
    // MySQL/MSSQL: event_type is VARCHAR without CHECK, no schema change needed.
    // MongoDB: schemaless, no change needed.
  },

  async down(_ctx: MigrationContext): Promise<void> {
    // Non-destructive; down is a no-op. Reverting the CHECK would reject rows
    // that legitimately use the new event type.
  },
};
