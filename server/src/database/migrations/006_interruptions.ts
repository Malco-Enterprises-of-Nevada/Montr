/**
 * Migration 006: Add interrupted_from_playlist_id to clients
 * Tracks which playlist was active before a high-priority interruption,
 * enabling resume after the interruption ends.
 */

import { Migration, MigrationContext } from './types';

const SQL_UP_SQLITE = `ALTER TABLE clients ADD COLUMN interrupted_from_playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL`;
const SQL_UP_MYSQL = `ALTER TABLE clients ADD COLUMN interrupted_from_playlist_id INT, ADD CONSTRAINT FK_clients_interrupted FOREIGN KEY (interrupted_from_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL`;
const SQL_UP_MSSQL = `ALTER TABLE clients ADD interrupted_from_playlist_id INT CONSTRAINT FK_clients_interrupted FOREIGN KEY REFERENCES playlists(id) ON DELETE SET NULL`;

export const migration: Migration = {
  version: '1.5.0',
  description: 'Add interrupted_from_playlist_id to clients for playlist interruption support',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      // MongoDB is schemaless; field will be added on first use
      return;
    }

    switch (ctx.adapterType) {
      case 'sqlite':
        await ctx.executeSql!(SQL_UP_SQLITE);
        break;
      case 'mysql':
        await ctx.executeSql!(SQL_UP_MYSQL);
        break;
      case 'mssql':
        await ctx.executeSql!(SQL_UP_MSSQL);
        break;
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('clients')
        .updateMany({}, { $unset: { interrupted_from_playlist_id: '' } });
      return;
    }

    if (ctx.adapterType === 'mssql') {
      await ctx.executeSql!('ALTER TABLE clients DROP CONSTRAINT FK_clients_interrupted');
    }
    if (ctx.adapterType === 'mysql') {
      await ctx.executeSql!('ALTER TABLE clients DROP FOREIGN KEY FK_clients_interrupted');
    }
    // SQLite < 3.35 can't DROP COLUMN; left in place for simplicity
    if (ctx.adapterType !== 'sqlite') {
      await ctx.executeSql!('ALTER TABLE clients DROP COLUMN interrupted_from_playlist_id');
    }
  },
};
