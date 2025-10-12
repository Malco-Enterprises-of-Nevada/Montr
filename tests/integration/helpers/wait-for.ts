import axios, { AxiosError } from 'axios';

export interface WaitOptions {
  timeout?: number;
  interval?: number;
  errorMessage?: string;
}

/**
 * Wait for a condition to become true by polling
 */
export async function waitForCondition(
  conditionFn: () => Promise<boolean> | boolean,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 10000;
  const interval = options.interval ?? 500;
  const errorMessage = options.errorMessage ?? 'Condition was not met within timeout';

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const result = await conditionFn();
      if (result) {
        return;
      }
    } catch (err) {
      // Condition function threw, continue waiting
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(`${errorMessage} (timeout: ${timeout}ms)`);
}

/**
 * Wait for server to respond to health check
 */
export async function waitForServerReady(
  serverUrl: string,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 30000;
  const interval = options.interval ?? 1000;

  await waitForCondition(
    async () => {
      try {
        const response = await axios.get(`${serverUrl}/api/health`, {
          timeout: 1000,
        });
        return response.status === 200;
      } catch (err) {
        return false;
      }
    },
    {
      timeout,
      interval,
      errorMessage: `Server at ${serverUrl} did not become ready`,
    }
  );
}

/**
 * Wait for client to be registered on the server
 */
export async function waitForClientRegistered(
  serverUrl: string,
  clientId: string,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 15000;
  const interval = options.interval ?? 500;

  await waitForCondition(
    async () => {
      try {
        const response = await axios.get(`${serverUrl}/api/clients/${clientId}`, {
          timeout: 1000,
        });
        return response.status === 200 && response.data.success === true;
      } catch (err) {
        const axiosError = err as AxiosError;
        if (axiosError.response?.status === 404) {
          // Client not found yet, keep waiting
          return false;
        }
        // Other errors, keep waiting
        return false;
      }
    },
    {
      timeout,
      interval,
      errorMessage: `Client ${clientId} was not registered on server`,
    }
  );
}

/**
 * Wait for client to be online
 */
export async function waitForClientOnline(
  serverUrl: string,
  clientId: string,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 15000;
  const interval = options.interval ?? 500;

  await waitForCondition(
    async () => {
      try {
        const response = await axios.get(`${serverUrl}/api/clients/${clientId}`, {
          timeout: 1000,
        });
        return (
          response.status === 200 &&
          response.data.success === true &&
          response.data.data.status === 'online'
        );
      } catch (err) {
        return false;
      }
    },
    {
      timeout,
      interval,
      errorMessage: `Client ${clientId} did not come online`,
    }
  );
}

/**
 * Wait for client to be offline
 */
export async function waitForClientOffline(
  serverUrl: string,
  clientId: string,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 10000;
  const interval = options.interval ?? 500;

  await waitForCondition(
    async () => {
      try {
        const response = await axios.get(`${serverUrl}/api/clients/${clientId}`, {
          timeout: 1000,
        });
        return (
          response.status === 200 &&
          response.data.success === true &&
          response.data.data.status === 'offline'
        );
      } catch (err) {
        return false;
      }
    },
    {
      timeout,
      interval,
      errorMessage: `Client ${clientId} did not go offline`,
    }
  );
}

/**
 * Wait for a playlist to exist
 */
export async function waitForPlaylistExists(
  serverUrl: string,
  playlistId: number,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 5000;
  const interval = options.interval ?? 500;

  await waitForCondition(
    async () => {
      try {
        const response = await axios.get(`${serverUrl}/api/playlists/${playlistId}`, {
          timeout: 1000,
        });
        return response.status === 200 && response.data.success === true;
      } catch (err) {
        return false;
      }
    },
    {
      timeout,
      interval,
      errorMessage: `Playlist ${playlistId} was not found`,
    }
  );
}

/**
 * Wait for client to have a specific playlist assigned
 */
export async function waitForPlaylistAssigned(
  serverUrl: string,
  clientId: string,
  playlistId: number,
  options: WaitOptions = {}
): Promise<void> {
  const timeout = options.timeout ?? 10000;
  const interval = options.interval ?? 500;

  await waitForCondition(
    async () => {
      try {
        const response = await axios.get(`${serverUrl}/api/clients/${clientId}`, {
          timeout: 1000,
        });
        return (
          response.status === 200 &&
          response.data.success === true &&
          response.data.data.assignedPlaylistId === playlistId
        );
      } catch (err) {
        return false;
      }
    },
    {
      timeout,
      interval,
      errorMessage: `Playlist ${playlistId} was not assigned to client ${clientId}`,
    }
  );
}

/**
 * Wait for a specific amount of time (helper for explicit delays)
 */
export async function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelay?: number;
    maxDelay?: number;
    backoffFactor?: number;
  } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  const initialDelay = options.initialDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 10000;
  const backoffFactor = options.backoffFactor ?? 2;

  let lastError: Error | null = null;
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err as Error;

      if (attempt === maxAttempts) {
        break;
      }

      await waitFor(delay);
      delay = Math.min(delay * backoffFactor, maxDelay);
    }
  }

  throw new Error(
    `Operation failed after ${maxAttempts} attempts. Last error: ${lastError?.message}`
  );
}
