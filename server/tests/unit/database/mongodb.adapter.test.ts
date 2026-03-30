/**
 * MongoDB adapter conformance tests
 * Requires a running MongoDB instance: TEST_MONGODB=true to enable
 */

import { runAdapterConformanceTests } from './adapter-conformance';

const SKIP = !process.env.TEST_MONGODB;

if (SKIP) {
  describe('MongoDB adapter (skipped)', () => {
    it('skipped — set TEST_MONGODB=true with a running MongoDB instance to enable', () => {
      expect(true).toBe(true);
    });
  });
} else {
  const { MongoDBAdapter } = require('../../../src/database/adapters/mongodb.adapter');

  runAdapterConformanceTests(
    'MongoDB',
    async () => {
      const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/montr_test';
      const adapter = new MongoDBAdapter(uri);
      await adapter.connect();
      return adapter;
    },
    async (adapter) => {
      await adapter.disconnect();
    },
  );
}
