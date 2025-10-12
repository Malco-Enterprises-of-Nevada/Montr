/**
 * Utility functions for waiting and polling in async tests.
 */

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  message?: string;
}

/**
 * Wait for a condition to become true.
 * Polls the condition function at regular intervals until it returns true.
 *
 * @param condition - Function that returns true when condition is met
 * @param options - Timeout, interval, and error message options
 * @returns Promise that resolves when condition is met
 * @throws Error if timeout is reached
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {}
): Promise<void> {
  const timeout = options.timeout || 10000; // 10 seconds default
  const interval = options.interval || 100; // 100ms default
  const message = options.message || 'Condition not met within timeout';

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await Promise.resolve(condition());
    if (result) {
      return;
    }
    await sleep(interval);
  }

  throw new Error(`${message} (timeout: ${timeout}ms)`);
}

/**
 * Wait for a specific amount of time.
 *
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after the specified time
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a value to be defined (not null or undefined).
 * Useful for waiting for database records or API responses.
 *
 * @param getter - Function that returns the value to check
 * @param options - Timeout and interval options
 * @returns Promise that resolves with the value when it becomes defined
 */
export async function waitForValue<T>(
  getter: () => T | null | undefined | Promise<T | null | undefined>,
  options: WaitForOptions = {}
): Promise<T> {
  const timeout = options.timeout || 10000;
  const interval = options.interval || 100;
  const message = options.message || 'Value not available within timeout';

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const value = await Promise.resolve(getter());
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(interval);
  }

  throw new Error(`${message} (timeout: ${timeout}ms)`);
}

/**
 * Retry an async operation a specified number of times.
 *
 * @param operation - Async function to retry
 * @param maxAttempts - Maximum number of attempts
 * @param delayMs - Delay between attempts in milliseconds
 * @returns Promise that resolves with operation result
 * @throws Last error if all attempts fail
 */
export async function retry<T>(
  operation: () => Promise<T>,
  maxAttempts = 3,
  delayMs = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError || new Error('Operation failed after retries');
}

/**
 * Wait for multiple conditions to all be true.
 *
 * @param conditions - Array of condition functions
 * @param options - Timeout and interval options
 * @returns Promise that resolves when all conditions are met
 */
export async function waitForAll(
  conditions: Array<() => boolean | Promise<boolean>>,
  options: WaitForOptions = {}
): Promise<void> {
  await waitFor(async () => {
    const results = await Promise.all(conditions.map((c) => Promise.resolve(c())));
    return results.every((r) => r === true);
  }, options);
}

/**
 * Wait for at least one condition to be true.
 *
 * @param conditions - Array of condition functions
 * @param options - Timeout and interval options
 * @returns Promise that resolves when any condition is met
 */
export async function waitForAny(
  conditions: Array<() => boolean | Promise<boolean>>,
  options: WaitForOptions = {}
): Promise<void> {
  await waitFor(async () => {
    const results = await Promise.all(conditions.map((c) => Promise.resolve(c())));
    return results.some((r) => r === true);
  }, options);
}
