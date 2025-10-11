/**
 * Common test helper utilities
 */

import { Response } from 'supertest';
import { ApiResponse } from '../../src/api/middleware/error-handler';

/**
 * Asserts that a response is a successful API response
 */
export const expectSuccessResponse = <T>(response: Response, expectedStatus: number = 200): T => {
  expect(response.status).toBe(expectedStatus);
  expect(response.body).toHaveProperty('success', true);
  expect(response.body).toHaveProperty('data');
  expect(response.body).toHaveProperty('error', null);
  return response.body.data as T;
};

/**
 * Asserts that a response is an error API response
 */
export const expectErrorResponse = (
  response: Response,
  expectedStatus: number,
  expectedCode?: string
): void => {
  expect(response.status).toBe(expectedStatus);
  expect(response.body).toHaveProperty('success', false);
  expect(response.body).toHaveProperty('data', null);
  expect(response.body).toHaveProperty('error');
  expect(response.body.error).toHaveProperty('code');
  expect(response.body.error).toHaveProperty('message');

  if (expectedCode) {
    expect(response.body.error.code).toBe(expectedCode);
  }
};

/**
 * Asserts that a response has validation errors
 */
export const expectValidationError = (response: Response, expectedFields?: string[]): void => {
  expectErrorResponse(response, 400, 'VALIDATION_ERROR');
  expect(response.body.error).toHaveProperty('details');
  expect(Array.isArray(response.body.error.details)).toBe(true);

  if (expectedFields) {
    const fields = response.body.error.details.map((err: any) => err.field);
    expectedFields.forEach((field) => {
      expect(fields).toContain(field);
    });
  }
};

/**
 * Creates a mock file buffer for upload testing
 */
export const createMockFileBuffer = (size: number = 1024): Buffer => {
  return Buffer.alloc(size, 'test-data');
};

/**
 * Delays execution for testing async operations
 */
export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Waits for a condition to be true with timeout
 */
export const waitFor = async (
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> => {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await delay(intervalMs);
  }

  throw new Error('Timeout waiting for condition');
};

/**
 * Generates a random UUID for testing
 */
export const generateTestUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

/**
 * Generates a test timestamp
 */
export const generateTestTimestamp = (offset: number = 0): string => {
  const date = new Date();
  date.setMilliseconds(date.getMilliseconds() + offset);
  return date.toISOString();
};

/**
 * Deep clones an object for testing
 */
export const deepClone = <T>(obj: T): T => {
  return JSON.parse(JSON.stringify(obj));
};

/**
 * Asserts that two objects match, ignoring specific fields
 */
export const expectObjectMatch = <T extends Record<string, any>>(
  actual: T,
  expected: Partial<T>,
  ignoreFields: string[] = []
): void => {
  const actualCopy = { ...actual };
  const expectedCopy = { ...expected };

  ignoreFields.forEach((field) => {
    delete actualCopy[field];
    delete expectedCopy[field];
  });

  expect(actualCopy).toMatchObject(expectedCopy);
};

/**
 * Asserts that an array contains an object matching the criteria
 */
export const expectArrayContainsObject = <T extends Record<string, any>>(
  array: T[],
  criteria: Partial<T>
): void => {
  const match = array.find((item) => {
    return Object.keys(criteria).every((key) => item[key] === criteria[key]);
  });

  expect(match).toBeDefined();
};

/**
 * Creates a sorted array copy for comparison
 */
export const sortByField = <T extends Record<string, any>>(array: T[], field: keyof T): T[] => {
  return [...array].sort((a, b) => {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
    return 0;
  });
};
