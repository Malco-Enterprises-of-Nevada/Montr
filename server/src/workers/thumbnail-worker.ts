/**
 * Thumbnail worker — runs ffmpeg + sharp in a forked child process
 * with a small heap cap (--max-old-space-size=256) so a malformed or
 * enormous source file cannot OOM-kill the main server.
 *
 * Protocol (IPC):
 *   parent → worker:  ThumbnailRequest
 *   worker → parent:  ThumbnailResponse
 *
 * The worker handles exactly one request, sends a response, and exits.
 * The parent (media.service.ts) owns the fork lifecycle, timeouts, and
 * storage-side persistence. This keeps the worker stateless and cheap
 * to kill if it misbehaves.
 */

import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import sharp from 'sharp';

const execFile = promisify(execFileCallback);

/** Shape of the ffprobe JSON we care about. */
interface FfprobeStream {
  index: number;
  codec_name?: string;
  disposition?: { attached_pic?: 0 | 1 };
}
interface FfprobeOutput {
  streams?: FfprobeStream[];
}

export interface ThumbnailRequest {
  type: 'video' | 'image';
  /** Local file path OR http(s) URL (presigned S3 URL, for streaming fast-seek) */
  source: string;
  /** Max width in pixels. Default 320. */
  width?: number;
  /** JPEG quality 1-100. Default 80. */
  quality?: number;
}

export type ThumbnailResponse =
  | { ok: true; buffer: Uint8Array }
  | { ok: false; error: string };

/**
 * Detect an "attached picture" stream (MP4 `covr` atom, MKV cover attachment,
 * etc.) via ffprobe. Returns the stream index of the cover, or null if none.
 *
 * For HTTP sources this fetches only the container header (a few hundred KB
 * at most); for local files it's a single pread.
 */
async function findAttachedPicStream(source: string): Promise<number | null> {
  try {
    const { stdout } = await execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v',
        '-show_entries',
        'stream=index,codec_name:stream_disposition=attached_pic',
        '-of',
        'json',
        source,
      ],
      { timeout: 30_000, maxBuffer: 1 * 1024 * 1024 }
    );
    const parsed: FfprobeOutput = JSON.parse(stdout);
    const cover = parsed.streams?.find((s) => s.disposition?.attached_pic === 1);
    return cover?.index ?? null;
  } catch {
    // ffprobe failure just means "no embedded art" for our purposes —
    // fall through to frame seek.
    return null;
  }
}

/**
 * Extract an embedded cover stream. Streams the PNG/JPEG payload from ffmpeg
 * via stdin→stdout pipe; no decode, no temp file.
 */
async function extractAttachedPic(
  source: string,
  streamIndex: number,
  width: number,
  quality: number
): Promise<Buffer> {
  const { stdout } = await execFile(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      source,
      '-map',
      `0:${streamIndex}`,
      '-c',
      'copy',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-',
    ],
    {
      timeout: 30_000,
      // Cover art can be a few MB (PNG). Cap at 16 MB — anything larger is
      // either malformed or someone shipped a 4K poster, neither of which
      // we need for a 320px thumbnail.
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    }
  );
  return await sharp(stdout as unknown as Buffer)
    .resize(width, width, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

async function generateVideoFrame(
  source: string,
  width: number,
  quality: number
): Promise<Buffer> {
  // Blu-ray rips and pre-tagged libraries commonly ship a cover frame in
  // the container itself. Skipping straight to that avoids spawning a
  // decoder on the movie at all — a kilobytes-level transfer instead of
  // megabytes, and zero decode cost.
  const coverIndex = await findAttachedPicStream(source);
  if (coverIndex !== null) {
    return await extractAttachedPic(source, coverIndex, width, quality);
  }

  const tempOutput = path.join(os.tmpdir(), `montr-thumb-${process.pid}-${Date.now()}.jpg`);
  try {
    // -ss BEFORE -i enables input-side fast-seek: for http(s) URLs this
    // triggers HTTP range requests so only a few MB are fetched near the
    // seek point, not the whole file. For local files it avoids decoding
    // from frame 0 on containers without a seek index.
    await execFile(
      'ffmpeg',
      [
        '-ss',
        '00:00:01.000',
        '-i',
        source,
        '-vframes',
        '1',
        '-vf',
        `scale=${width}:-1`,
        '-y',
        tempOutput,
      ],
      { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 }
    );
    return await sharp(tempOutput).jpeg({ quality }).toBuffer();
  } finally {
    await fs.unlink(tempOutput).catch(() => {});
  }
}

async function generateImage(source: string, width: number, quality: number): Promise<Buffer> {
  return await sharp(source)
    .resize(width, width, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

async function handle(req: ThumbnailRequest): Promise<ThumbnailResponse> {
  const width = req.width ?? 320;
  const quality = req.quality ?? 80;
  try {
    const buffer =
      req.type === 'video'
        ? await generateVideoFrame(req.source, width, quality)
        : await generateImage(req.source, width, quality);
    return { ok: true, buffer: new Uint8Array(buffer) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Entry ─────────────────────────────────────────────────────────────
// One message, one reply, then exit. If the worker hangs on a misbehaving
// ffmpeg, the parent's timeout will SIGKILL us — this is by design.
if (!process.send) {
  // Launched standalone (not forked). Nothing to do.
  process.exit(0);
}

process.once('message', async (msg: ThumbnailRequest) => {
  const response = await handle(msg);
  // send() is async but we exit from the drain callback so the parent
  // reliably receives the payload before the socket closes.
  process.send!(response, undefined, undefined, () => {
    process.exit(response.ok ? 0 : 1);
  });
});
