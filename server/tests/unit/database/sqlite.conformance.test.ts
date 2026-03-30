/**
 * SQLite adapter conformance tests
 * Runs the shared test suite against an in-memory SQLite database
 */

import { SQLiteAdapter } from '../../../src/database/adapters/sqlite.adapter';
import { runAdapterConformanceTests } from './adapter-conformance';
import fs from 'fs';
import path from 'path';

// Unique dir per test run to avoid conflicts
let testDir: string;

runAdapterConformanceTests(
  'SQLite',
  async () => {
    testDir = path.join('/tmp', `montr-conformance-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    fs.mkdirSync(testDir, { recursive: true });
    const adapter = new SQLiteAdapter(path.join(testDir, 'test.db'));
    await adapter.connect();
    return adapter;
  },
  async (adapter) => {
    await adapter.disconnect();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  },
);
