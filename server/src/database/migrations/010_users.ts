/**
 * Migration 010: Add users table
 * Enables user authentication with role-based access control.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin', 'editor', 'viewer')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
];

const MYSQL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'viewer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX idx_users_username ON users(username)`,
  `CREATE INDEX idx_users_email ON users(email)`,
];

const MSSQL_STATEMENTS = [
  `CREATE TABLE users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    username NVARCHAR(100) NOT NULL UNIQUE,
    email NVARCHAR(255) NOT NULL UNIQUE,
    password_hash NVARCHAR(255) NOT NULL,
    role NVARCHAR(10) NOT NULL DEFAULT 'viewer',
    created_at DATETIME2 DEFAULT GETDATE()
  )`,
  `CREATE INDEX idx_users_username ON users(username)`,
  `CREATE INDEX idx_users_email ON users(email)`,
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.9.0',
  description: 'Add users table for authentication and RBAC',

  async up(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      await db.createCollection('users');
      await db.collection('users').createIndex({ username: 1 }, { unique: true });
      await db.collection('users').createIndex({ email: 1 }, { unique: true });
      await db
        .collection('counters')
        .updateOne(
          { _id: 'users' as unknown as import('mongodb').ObjectId },
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
        .collection('users')
        .drop()
        .catch(() => {});
      return;
    }

    await executeStatements(ctx, ['DROP TABLE IF EXISTS users']);
  },
};
