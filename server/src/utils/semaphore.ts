/**
 * Minimal async semaphore. Caps concurrency of heavy operations so they
 * don't all land at once and exhaust memory (see OOM kill during 3x
 * concurrent 500MB+ video uploads on Spaces backend).
 */

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) throw new Error('Semaphore max must be >= 1');
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  stats(): { active: number; queued: number; max: number } {
    return { active: this.active, queued: this.queue.length, max: this.max };
  }
}
