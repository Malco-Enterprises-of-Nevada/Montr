/**
 * Migration 019: Add entra_oid to users (Microsoft Entra ID SSO).
 *
 * Stores the Entra `oid` (object id) bound to a user on their first successful
 * SSO login. `oid` is the stable primary identity key for SSO (UPNs/emails are
 * mutable/recyclable) — see SSO_MASTER_PLAN.md §B(3). The column is nullable so
 * local-only accounts are unaffected, and uniquely indexed (sparse / filtered)
 * so two users can never bind the same Entra identity.
 */

import { Migration, MigrationContext } from './types';

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

const SQLITE_UP = [
  `ALTER TABLE users ADD COLUMN entra_oid TEXT`,
  // Partial unique index: enforces uniqueness only across non-NULL values so
  // any number of local-only accounts (entra_oid IS NULL) can coexist.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_oid ON users(entra_oid) WHERE entra_oid IS NOT NULL`,
];

const MYSQL_UP = [
  // MySQL UNIQUE allows multiple NULLs, so a plain unique key is already sparse.
  `ALTER TABLE users ADD COLUMN entra_oid VARCHAR(64) NULL`,
  `ALTER TABLE users ADD UNIQUE INDEX idx_users_entra_oid (entra_oid)`,
];

const MSSQL_UP = [
  `ALTER TABLE users ADD entra_oid NVARCHAR(64) NULL`,
  // SQL Server: a filtered unique index is the sparse-unique equivalent.
  `CREATE UNIQUE INDEX idx_users_entra_oid ON users(entra_oid) WHERE entra_oid IS NOT NULL`,
];

export const migration: Migration = {
  version: '2.6.0',
  description: 'Add entra_oid to users for Microsoft Entra ID SSO',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.collection('users').createIndex({ entra_oid: 1 }, { unique: true, sparse: true });
      return;
    }

    switch (ctx.adapterType) {
      case 'sqlite':
        await executeStatements(ctx, SQLITE_UP);
        break;
      case 'mysql':
        await executeStatements(ctx, MYSQL_UP);
        break;
      case 'mssql':
        await executeStatements(ctx, MSSQL_UP);
        break;
      default:
        throw new Error(`Unsupported adapter type: ${ctx.adapterType}`);
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db
        .collection('users')
        .dropIndex('entra_oid_1')
        .catch(() => {});
      await db.collection('users').updateMany({}, { $unset: { entra_oid: '' } });
      return;
    }

    if (ctx.adapterType === 'mysql') {
      await ctx.executeSql!(`ALTER TABLE users DROP INDEX idx_users_entra_oid`);
      await ctx.executeSql!(`ALTER TABLE users DROP COLUMN entra_oid`);
      return;
    }

    // SQLite (>= 3.35 DROP COLUMN) and MSSQL: drop the index then the column.
    await ctx.executeSql!(`DROP INDEX IF EXISTS idx_users_entra_oid`).catch(async () => {
      // MSSQL spells it `DROP INDEX idx ON users`.
      await ctx.executeSql!(`DROP INDEX idx_users_entra_oid ON users`);
    });
    await ctx.executeSql!(`ALTER TABLE users DROP COLUMN entra_oid`);
  },
};
