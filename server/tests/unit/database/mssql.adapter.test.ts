/**
 * MSSQL adapter conformance tests
 * Requires a running SQL Server instance: TEST_MSSQL=true to enable
 */

import { runAdapterConformanceTests } from './adapter-conformance';

const SKIP = !process.env.TEST_MSSQL;

if (SKIP) {
  describe('MSSQL adapter (skipped)', () => {
    it('skipped — set TEST_MSSQL=true with a running SQL Server instance to enable', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const { MSSQLAdapter } = require('../../../src/database/adapters/mssql.adapter');

  runAdapterConformanceTests(
    'MSSQL',
    async () => {
      const adapter = new MSSQLAdapter({
        server: process.env.MSSQL_SERVER || 'localhost',
        port: parseInt(process.env.MSSQL_PORT || '1433', 10),
        user: process.env.MSSQL_USER || 'sa',
        password: process.env.MSSQL_PASSWORD || 'Montr_Test_123!',
        database: process.env.MSSQL_DATABASE || 'montr_test',
      });
      await adapter.connect();
      return adapter;
    },
    async (adapter) => {
      await adapter.disconnect();
    },
  );
}
