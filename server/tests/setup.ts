/**
 * Global test setup and configuration
 * This file is loaded before all tests via Jest configuration
 */

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.HOST = '0.0.0.0';
process.env.DB_TYPE = 'sqlite';
process.env.DB_PATH = ':memory:';
process.env.STORAGE_PATH = '/tmp/montr-test-storage';
process.env.LOG_LEVEL = 'error'; // Suppress logs during tests (uses real logger)
process.env.LOG_FILE = '/tmp/montr-test.log'; // Write test logs to temp file

// Mock sharp for image processing
jest.mock('sharp', () => {
  const mockSharp = jest.fn(() => ({
    resize: jest.fn().mockReturnThis(),
    jpeg: jest.fn().mockReturnThis(),
    toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-image-buffer')),
    metadata: jest.fn().mockResolvedValue({
      width: 1920,
      height: 1080,
      format: 'jpeg',
    }),
  }));
  return mockSharp;
});

// Global test timeout
jest.setTimeout(10000);

// Clean up after all tests
afterAll(async () => {
  // Add any global cleanup here if needed
});
