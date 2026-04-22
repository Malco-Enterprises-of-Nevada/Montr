/**
 * Thumbnail queue service
 *
 * Drains the `thumbnail_jobs` table one job at a time, calling into
 * mediaService.processThumbnailJob() for the actual work. Runs in the
 * main process but all heavy lifting (ffmpeg, sharp) happens inside the
 * forked thumbnail worker, so a single bad file cannot OOM the server.
 *
 * Design notes:
 *   - Single in-flight job, serialised by the existing thumbnailSemaphore.
 *     SQLite on a single node doesn't benefit from parallel thumbnail gen,
 *     and fanning out forks would defeat the whole memory-containment story.
 *   - Polling (not push): simpler than listen/notify, survives DB restarts,
 *     and the idle path is cheap (one SELECT every POLL_INTERVAL_MS).
 *   - On startup, requeueRunningThumbnailJobs() flips any stranded 'running'
 *     rows back to 'queued' so crash recovery is automatic.
 */

import { getDatabase } from '../database/connection';
import { getLogger } from '../utils/logger';
import { mediaService } from './media.service';

const logger = getLogger();

/** How often to poll when the queue was empty on the last iteration. */
const POLL_INTERVAL_MS = 2_000;

class ThumbnailQueueService {
  private running = false;
  private stopRequested = false;

  /**
   * Start the background poller. Should be called once at server startup
   * AFTER the database connection and migrations are ready.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;

    // Recover jobs that were 'running' when the last process died.
    try {
      const db = await getDatabase();
      const requeued = await db.requeueRunningThumbnailJobs();
      if (requeued > 0) {
        logger.warn(`Requeued ${requeued} stranded thumbnail job(s) from previous run`);
      }
    } catch (err) {
      logger.error('Failed to requeue stranded thumbnail jobs on startup:', err);
    }

    void this.runLoop();
    logger.info('Thumbnail queue service started');
  }

  /** Stop the poller (e.g. during graceful shutdown). */
  async stop(): Promise<void> {
    this.stopRequested = true;
    // Let the current iteration finish naturally; the runLoop exits on
    // its next sleep boundary (worst case: POLL_INTERVAL_MS).
    this.running = false;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopRequested) {
      try {
        const drainedOne = await this.runOne();
        if (!drainedOne) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      } catch (err) {
        logger.error('Thumbnail queue runLoop iteration failed:', err);
        // Back off briefly so a persistent DB error doesn't spin the CPU.
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    this.running = false;
  }

  private async runOne(): Promise<boolean> {
    const db = await getDatabase();
    const job = await db.claimNextThumbnailJob();
    if (!job) return false;

    try {
      await mediaService.processThumbnailJob(job.media_id);
      await db.markThumbnailJobDone(job.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Thumbnail job ${job.id} (media ${job.media_id}) failed: ${msg}`);
      await db.markThumbnailJobFailed(job.id, msg);
    }
    return true;
  }
}

export const thumbnailQueueService = new ThumbnailQueueService();
