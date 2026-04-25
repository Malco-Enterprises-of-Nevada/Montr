/**
 * Migration 018: Per-media playback quality metrics on playback_logs
 *
 * Adds four nullable columns the client populates when ending a playback
 * session: rebuffer count, dropped video frames, time-to-first-frame, and
 * decoder error count. Old clients omit these fields and the columns stay
 * NULL, so the migration is fully backward compatible.
 */

import { Migration, MigrationContext } from './types';

const SQLITE_UP = [
  `ALTER TABLE playback_logs ADD COLUMN rebuffer_count INTEGER`,
  `ALTER TABLE playback_logs ADD COLUMN dropped_frames INTEGER`,
  `ALTER TABLE playback_logs ADD COLUMN time_to_first_frame_ms INTEGER`,
  `ALTER TABLE playback_logs ADD COLUMN decoder_errors INTEGER`,
];

const MYSQL_UP = [
  `ALTER TABLE playback_logs ADD COLUMN rebuffer_count INT NULL`,
  `ALTER TABLE playback_logs ADD COLUMN dropped_frames INT NULL`,
  `ALTER TABLE playback_logs ADD COLUMN time_to_first_frame_ms INT NULL`,
  `ALTER TABLE playback_logs ADD COLUMN decoder_errors INT NULL`,
];

const MSSQL_UP = [
  `ALTER TABLE playback_logs ADD rebuffer_count INT NULL`,
  `ALTER TABLE playback_logs ADD dropped_frames INT NULL`,
  `ALTER TABLE playback_logs ADD time_to_first_frame_ms INT NULL`,
  `ALTER TABLE playback_logs ADD decoder_errors INT NULL`,
];

const SQLITE_DOWN = [
  `ALTER TABLE playback_logs DROP COLUMN rebuffer_count`,
  `ALTER TABLE playback_logs DROP COLUMN dropped_frames`,
  `ALTER TABLE playback_logs DROP COLUMN time_to_first_frame_ms`,
  `ALTER TABLE playback_logs DROP COLUMN decoder_errors`,
];

const QUALITY_FIELDS = [
  'rebuffer_count',
  'dropped_frames',
  'time_to_first_frame_ms',
  'decoder_errors',
];

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '2.5.0',
  description: 'Add per-media playback quality columns to playback_logs',

  async up(ctx: MigrationContext): Promise<void> {
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
      case 'mongodb':
        // Document store: no schema change needed. New documents will simply
        // include the optional fields when the client provides them.
        return;
      default:
        throw new Error(`Unsupported adapter type: ${ctx.adapterType}`);
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      const db = ctx.getMongoDb!();
      const unset: Record<string, ''> = {};
      for (const f of QUALITY_FIELDS) unset[f] = '';
      await db.collection('playback_logs').updateMany({}, { $unset: unset });
      return;
    }

    // SQLite >= 3.35 supports DROP COLUMN. The project tests against modern
    // SQLite, so this matches the pattern used in 002 for newer schemas.
    if (ctx.adapterType === 'sqlite') {
      await executeStatements(ctx, SQLITE_DOWN);
      return;
    }

    // MySQL / MSSQL
    for (const f of QUALITY_FIELDS) {
      await ctx.executeSql!(`ALTER TABLE playback_logs DROP COLUMN ${f}`);
    }
  },
};
