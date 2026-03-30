/**
 * MySQL adapter conformance tests
 * Requires a running MySQL instance: TEST_MYSQL=true to enable
 */

import { runAdapterConformanceTests } from './adapter-conformance';

const SKIP = !process.env.TEST_MYSQL;

if (SKIP) {
  describe('MySQL adapter (skipped)', () => {
    it('skipped — set TEST_MYSQL=true with a running MySQL instance to enable', () => {
      expect(true).toBe(true);
    });
  });
} else {
  // Dynamic import to avoid requiring mysql2 when tests are skipped
  const { MySQLAdapter } = require('../../../src/database/adapters/mysql.adapter');

  runAdapterConformanceTests(
    'MySQL',
    async () => {
      const adapter = new MySQLAdapter({
        host: process.env.MYSQL_HOST || 'localhost',
        port: parseInt(process.env.MYSQL_PORT || '3306', 10),
        user: process.env.MYSQL_USER || 'montr',
        password: process.env.MYSQL_PASSWORD || 'montr_test',
        database: process.env.MYSQL_DATABASE || 'montr_test',
      });
      await adapter.connect();
      return adapter;
    },
    async (adapter) => {
      await adapter.disconnect();
    },
  );
}
