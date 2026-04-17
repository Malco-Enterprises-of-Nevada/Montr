/**
 * Migration runner tests
 * Uses SQLite in-memory databases for fast, isolated testing
 */

import { SQLiteAdapter } from '../../../src/database/adapters/sqlite.adapter';
import { MigrationRunner } from '../../../src/database/migrations/runner';
import fs from 'fs';
import path from 'path';

describe('MigrationRunner', () => {
  let adapter: SQLiteAdapter;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join('/tmp', `montr-migration-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    fs.mkdirSync(testDir, { recursive: true });
    adapter = new SQLiteAdapter(path.join(testDir, 'test.db'));
    await adapter.connect(); // This runs migrations automatically
  });

  afterEach(async () => {
    await adapter.disconnect();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should create schema_migrations table', async () => {
    const executor = adapter.getMigrationExecutor();
    const exists = await executor.tableExists('schema_migrations');
    expect(exists).toBe(true);
  });

  it('should record applied migration', async () => {
    const executor = adapter.getMigrationExecutor();
    const rows = await executor.querySql!<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].version).toBe('1.0.0');
  });

  it('should create all expected tables', async () => {
    const executor = adapter.getMigrationExecutor();
    for (const table of ['media_files', 'playlists', 'playlist_items', 'clients', 'client_status', 'system_state', 'client_groups', 'client_group_members', 'schedules', 'client_playlists', 'playback_logs', 'notification_rules', 'notification_history', 'approval_logs', 'users', 'client_telemetry', 'client_log_events']) {
      const exists = await executor.tableExists(table);
      expect(exists).toBe(true);
    }
  });

  it('should update schema_version in system_state', async () => {
    const executor = adapter.getMigrationExecutor();
    const rows = await executor.querySql!<{ value: string }>(
      "SELECT value FROM system_state WHERE key = 'schema_version'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('2.2.0');
  });

  it('should not re-run already applied migrations', async () => {
    // Running migrations again should be a no-op
    const executor = adapter.getMigrationExecutor();
    const runner = new MigrationRunner(executor);
    await runner.run(); // Should not throw

    const rows = await executor.querySql!<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    // Should still have all applied migrations (001 through the latest)
    expect(rows).toHaveLength(15);
  });

  it('should report migration status', async () => {
    const executor = adapter.getMigrationExecutor();
    const runner = new MigrationRunner(executor);
    const status = await runner.status();

    expect(status.length).toBeGreaterThanOrEqual(1);
    expect(status[0].version).toBe('1.0.0');
    expect(status[0].applied).toBe(true);
    expect(status[0].applied_at).not.toBeNull();
  });

  it('should detect existing database and baseline', async () => {
    // Create a fresh database with just the schema (simulating pre-migration DB)
    const baselineDir = path.join('/tmp', `montr-baseline-${Date.now()}`);
    fs.mkdirSync(baselineDir, { recursive: true });
    const baselineAdapter = new SQLiteAdapter(path.join(baselineDir, 'test.db'));

    // Connect — this will run migrations. The runner should detect
    // the fresh DB has no schema_migrations yet and create one + baseline
    await baselineAdapter.connect();

    const executor = baselineAdapter.getMigrationExecutor();
    // Order by rowid so we read insertion order, not the lexicographic order
    // SQLite would otherwise use from the unique index on `version`.
    const rows = await executor.querySql!<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY rowid',
    );
    expect(rows).toHaveLength(15);
    expect(rows[0].version).toBe('1.0.0');
    expect(rows[1].version).toBe('1.1.0');
    expect(rows[2].version).toBe('1.2.0');
    expect(rows[3].version).toBe('1.3.0');
    expect(rows[4].version).toBe('1.4.0');
    expect(rows[5].version).toBe('1.5.0');
    expect(rows[6].version).toBe('1.6.0');
    expect(rows[7].version).toBe('1.7.0');
    expect(rows[8].version).toBe('1.8.0');
    expect(rows[9].version).toBe('1.9.0');
    expect(rows[10].version).toBe('1.10.0');
    expect(rows[11].version).toBe('1.11.0');
    expect(rows[12].version).toBe('2.0.0');
    expect(rows[13].version).toBe('2.1.0');
    expect(rows[14].version).toBe('2.2.0');

    await baselineAdapter.disconnect();
    fs.rmSync(baselineDir, { recursive: true, force: true });
  });
});
