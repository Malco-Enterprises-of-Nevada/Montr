/**
 * Session Store Interface
 * Abstracts session/state storage for single-node (in-memory) and
 * multi-node (Redis) deployments. Currently provides an in-memory
 * implementation; Redis can be plugged in when cluster mode is enabled.
 */

export interface SessionStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

/**
 * In-memory session store (single-node default)
 */
export class MemorySessionStore implements SessionStore {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.store.keys()).filter((k) => regex.test(k));
  }
}

let sessionStore: SessionStore | null = null;

/**
 * Gets the session store instance.
 * Uses in-memory by default; could be swapped to Redis when cluster mode is enabled.
 */
export function getSessionStore(): SessionStore {
  if (!sessionStore) {
    sessionStore = new MemorySessionStore();
  }
  return sessionStore;
}

/**
 * Sets a custom session store (e.g., Redis-backed)
 */
export function setSessionStore(store: SessionStore): void {
  sessionStore = store;
}
