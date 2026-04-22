/**
 * Parent-side runner for the thumbnail worker. Forks a child with a tight
 * heap cap, sends it one request, returns the JPEG buffer (or throws).
 *
 * Why a fork and not a thread:
 *   - ffmpeg is a subprocess anyway, and its RSS counts against whoever
 *     spawned it. Isolating it to a child cgroup-less child means a 4K HDR
 *     decode that allocates 1 GB only kills the worker, not the API.
 *   - sharp uses libvips which can allocate large native buffers; same
 *     rationale — contain the blast radius.
 *   - We don't need shared memory, and worker_threads would still count
 *     toward the main process's Node heap.
 */

import { fork, ChildProcess } from 'child_process';
import path from 'path';
import type { ThumbnailRequest, ThumbnailResponse } from './thumbnail-worker';

/** How long to wait for the worker before we SIGKILL it. */
const WORKER_TIMEOUT_MS = 90_000;

/** V8 heap cap for the worker. Matches the small footprint of one ffmpeg
 *  seek + one sharp re-encode; too low and legitimate 4K frames fail. */
const WORKER_MAX_OLD_SPACE_MB = 256;

/**
 * Resolve the compiled worker script path. In production (dist/) this file
 * lives at dist/workers/thumbnail-runner.js and its sibling worker is at
 * dist/workers/thumbnail-worker.js. `__dirname` handles both.
 */
function workerScriptPath(): string {
  return path.join(__dirname, 'thumbnail-worker.js');
}

export async function runThumbnailWorker(req: ThumbnailRequest): Promise<Buffer> {
  const script = workerScriptPath();
  const child: ChildProcess = fork(script, [], {
    execArgv: [`--max-old-space-size=${WORKER_MAX_OLD_SPACE_MB}`],
    // Inherit stdio so ffmpeg/sharp errors land in the server log instead
    // of vanishing. stderr: 'inherit' keeps it tied to our log pipeline.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Thumbnail worker timed out after ${WORKER_TIMEOUT_MS}ms`));
    }, WORKER_TIMEOUT_MS);

    child.once('message', (msg: ThumbnailResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (msg.ok) {
        resolve(Buffer.from(msg.buffer));
      } else {
        reject(new Error(msg.error));
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`Thumbnail worker exited before responding (code=${code}, signal=${signal})`)
      );
    });

    child.send(req);
  });
}
