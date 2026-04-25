/**
 * Upload-completion queue service
 *
 * Drains the `upload_completion_jobs` table one row at a time, calling
 * `mediaService.processUploadCompletionJob()` for the actual work
 * (download-from-S3 + SHA-256 + dedup + ffprobe + create media row +
 * enqueue thumbnail). Lives alongside the thumbnail queue and mirrors its
 * shape — only the terminal-state dispatch differs, because this queue
 * has a `'duplicate'` outcome on top of the usual done/failed.
 *
 * Why async: POST /api/media/upload/:id/complete used to do all the
 * above inside one HTTP request. For 100 GB files that ran 15-20 min,
 * which tripped Cloudflare Free's 100 s origin timeout. Now /complete
 * finalises the S3 multipart (fast) + enqueues a row, and this service
 * does the rest in the background while the client polls /status.
 */

import { getDatabase } from '../database/connection';
import { getLogger } from '../utils/logger';
import { mediaService } from './media.service';

const logger = getLogger();

/** How often to poll when the queue was empty on the last iteration. */
const POLL_INTERVAL_MS = 2_000;

class UploadCompletionQueueService {
  private running = false;
  private stopRequested = false;

  /**
   * Start the background poller. Call once after DB migrations are live.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;

    // Recover jobs that were 'running' when the last process died so
    // an ill-timed crash can't strand a half-processed upload forever.
    try {
      const db = await getDatabase();
      const requeued = await db.requeueRunningUploadCompletionJobs();
      if (requeued > 0) {
        logger.warn(`Requeued ${requeued} stranded upload-completion job(s) from previous run`);
      }
    } catch (err) {
      logger.error('Failed to requeue stranded upload-completion jobs on startup:', err);
    }

    void this.runLoop();
    logger.info('Upload-completion queue service started');
  }

  /** Stop the poller (graceful shutdown). */
  async stop(): Promise<void> {
    this.stopRequested = true;
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
        logger.error('Upload-completion queue runLoop iteration failed:', err);
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
    this.running = false;
  }

  private async runOne(): Promise<boolean> {
    const db = await getDatabase();
    const job = await db.claimNextUploadCompletionJob();
    if (!job) return false;

    try {
      const result = await mediaService.processUploadCompletionJob(job);
      if (result.kind === 'created') {
        await db.markUploadCompletionJobDone(job.id, result.mediaId);
      } else {
        await db.markUploadCompletionJobDuplicate(job.id, result.existingMediaId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Upload completion job ${job.id} (upload_id=${job.upload_id}) failed: ${msg}`);
      await db.markUploadCompletionJobFailed(job.id, msg);
    }
    return true;
  }
}

export const uploadCompletionQueueService = new UploadCompletionQueueService();
