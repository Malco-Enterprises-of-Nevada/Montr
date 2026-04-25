/**
 * Media Service
 * Handles media file operations, metadata extraction, and thumbnail generation
 */

import { promisify } from 'util';
import path from 'path';
import { execFile as execFileCallback } from 'child_process';
import sharp from 'sharp';
import { getDatabase } from '../database/connection';
import { config } from '../config/config';
import { storageService, StorageFileInfo } from './storage.service';
import { notificationService } from './notification.service';
import {
  MediaFile,
  CreateMediaInput,
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  UploadCompletionJob,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { postProcessSemaphore, thumbnailSemaphore } from './processing-limits';
import { runThumbnailWorker } from '../workers/thumbnail-runner';
import { calculateFileChecksumStream } from '../utils/checksum';

const execFile = promisify(execFileCallback);
const logger = getLogger();

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
  bitrate?: number;
}

/**
 * Describes one subtitle stream discovered inside a video container by
 * ffprobe. Maps directly onto a `subtitle_tracks(kind='embedded', ...)` row.
 */
export interface EmbeddedSubtitleStream {
  stream_index: number;
  codec: string;
  language: string | null;
  label: string | null;
  is_default: boolean;
  is_forced: boolean;
}

/**
 * Bitmap subtitle codecs (PGS, DVD VobSub, HDMV) — these are out of scope
 * for v1 since they can't be rendered as SRT/VTT text. Skip during ingest.
 */
const UNSUPPORTED_SUBTITLE_CODECS = new Set([
  'hdmv_pgs_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'xsub',
]);

export class MediaService {
  /**
   * Determines media type from MIME type
   */
  private getMediaType(mimeType: string): 'video' | 'image' {
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('image/')) return 'image';
    throw new AppError(ErrorCode.INVALID_MEDIA_TYPE, `Unsupported media type: ${mimeType}`, 400);
  }

  /**
   * Extracts metadata from a video file using ffprobe. Returns both the
   * video-stream metadata we store on `media_files` and any text-based
   * subtitle streams found in the container (so the caller can register
   * them in `subtitle_tracks` as kind='embedded').
   */
  private async extractVideoMetadata(
    filePath: string
  ): Promise<{ metadata: MediaMetadata; subtitles: EmbeddedSubtitleStream[] }> {
    try {
      const { stdout } = await execFile('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]);

      const data = JSON.parse(stdout);
      type RawStream = {
        index: number;
        codec_type: string;
        codec_name?: string;
        width?: number;
        height?: number;
        tags?: { language?: string; title?: string; LANGUAGE?: string; TITLE?: string };
        disposition?: { default?: number; forced?: number };
      };
      const streams: RawStream[] = Array.isArray(data.streams) ? data.streams : [];

      const videoStream = streams.find((s) => s.codec_type === 'video');

      const metadata: MediaMetadata = {
        duration: data.format?.duration ? parseFloat(data.format.duration) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        bitrate: data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : undefined,
      };

      const subtitles: EmbeddedSubtitleStream[] = streams
        .filter((s) => s.codec_type === 'subtitle')
        .filter((s) => !s.codec_name || !UNSUPPORTED_SUBTITLE_CODECS.has(s.codec_name))
        .map((s) => ({
          stream_index: s.index,
          codec: s.codec_name ?? 'unknown',
          language: s.tags?.language ?? s.tags?.LANGUAGE ?? null,
          label: s.tags?.title ?? s.tags?.TITLE ?? null,
          is_default: s.disposition?.default === 1,
          is_forced: s.disposition?.forced === 1,
        }));

      return { metadata, subtitles };
    } catch (error) {
      logger.error('Failed to extract video metadata:', error);
      return { metadata: {}, subtitles: [] };
    }
  }

  /**
   * Extracts metadata from an image file using sharp
   */
  private async extractImageMetadata(filePath: string): Promise<MediaMetadata> {
    try {
      const metadata = await sharp(filePath).metadata();
      return {
        width: metadata.width,
        height: metadata.height,
      };
    } catch (error) {
      logger.error('Failed to extract image metadata:', error);
      return {};
    }
  }

  /**
   * Generates a thumbnail for a video file by forking a worker process
   * that runs ffmpeg+sharp with a tight heap cap. Isolates decode errors
   * and memory spikes from the main API event loop.
   */
  private async generateVideoThumbnail(
    source: string,
    mediaFilename: string
  ): Promise<string | null> {
    try {
      const buffer = await runThumbnailWorker({ type: 'video', source });
      return await storageService.saveThumbnail(buffer, mediaFilename);
    } catch (error) {
      logger.error('Failed to generate video thumbnail:', error);
      return null;
    }
  }

  /**
   * Generates a thumbnail for an image file (forked worker for parity with
   * video path — libvips can allocate large native buffers on huge PNGs).
   */
  private async generateImageThumbnail(
    source: string,
    mediaFilename: string
  ): Promise<string | null> {
    try {
      const buffer = await runThumbnailWorker({ type: 'image', source });
      return await storageService.saveThumbnail(buffer, mediaFilename);
    } catch (error) {
      logger.error('Failed to generate image thumbnail:', error);
      return null;
    }
  }

  /**
   * Creates a new media file entry
   */
  async createMedia(
    file: Express.Multer.File,
    options?: { folderId?: number | null }
  ): Promise<MediaFile> {
    try {
      // Save file to storage
      const storageInfo: StorageFileInfo = await storageService.saveUploadedFile(file);

      // Determine media type
      const mediaType = this.getMediaType(file.mimetype);

      // Get full path for metadata extraction
      const fullPath = storageService.getFullPath(storageInfo.filepath);

      // Extract metadata based on type
      let metadata: MediaMetadata = {};
      let embeddedSubtitles: EmbeddedSubtitleStream[] = [];
      if (mediaType === 'video') {
        const result = await this.extractVideoMetadata(fullPath);
        metadata = result.metadata;
        embeddedSubtitles = result.subtitles;
      } else if (mediaType === 'image') {
        metadata = await this.extractImageMetadata(fullPath);
      }

      // Check for duplicate by checksum
      const db = await getDatabase();
      const existingMedia = await db.getMediaByChecksum(storageInfo.checksum);
      if (existingMedia) {
        // Delete the newly uploaded file since it's a duplicate
        await storageService.deleteFile(storageInfo.filepath);
        throw new AppError(
          ErrorCode.RESOURCE_ALREADY_EXISTS,
          'A media file with the same content already exists',
          409,
          true,
          { existingMediaId: existingMedia.id }
        );
      }

      // If a folder was requested, make sure it exists. Bad folder_id = 400
      // rather than relying on the FK to throw a cryptic error later.
      if (options?.folderId != null) {
        const folder = await db.getMediaFolderById(options.folderId);
        if (!folder) {
          await storageService.deleteFile(storageInfo.filepath);
          throw new AppError(
            ErrorCode.FOLDER_NOT_FOUND,
            `Folder with ID ${options.folderId} not found`,
            404
          );
        }
      }

      // Create media entry in database
      const input: CreateMediaInput = {
        filename: storageInfo.filename,
        original_filename: file.originalname,
        filepath: storageInfo.filepath,
        type: mediaType,
        mime_type: file.mimetype,
        file_size: storageInfo.size,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        checksum: storageInfo.checksum,
        folder_id: options?.folderId ?? null,
      };

      const media = await db.createMedia(input);

      // Register any embedded subtitle streams detected in the container.
      if (embeddedSubtitles.length > 0) {
        await this.persistEmbeddedSubtitles(media.id, embeddedSubtitles);
      }

      // Enqueue thumbnail job — picked up by the background queue poller,
      // persists across crashes and restarts.
      void this.enqueueThumbnail(media.id);

      this.fireApprovalNeededIfPending(media);

      logger.info(`Media created: ${media.id} - ${media.filename}`);
      return media;
    } catch (error) {
      // If error occurs after file save, clean up the file
      if (error instanceof AppError && error.code !== ErrorCode.RESOURCE_ALREADY_EXISTS) {
        // File cleanup already handled in duplicate case
      }
      throw error;
    }
  }

  /**
   * Finish a chunked upload asynchronously. Invoked by
   * `uploadCompletionQueueService` after POST /api/media/upload/:id/complete
   * returns 202. Responsible for the slow work that used to live inline:
   *   1. Download source to a single temp file (one network round-trip).
   *   2. SHA-256 the temp file.
   *   3. If the checksum matches an existing media row → delete the newly
   *      uploaded object and return `{ kind: 'duplicate' }`. No throw.
   *   4. Run ffprobe/sharp metadata extraction on the same temp file.
   *   5. Insert the media row, persist embedded subtitles, enqueue thumbnail.
   *
   * Wrapped in `postProcessSemaphore.run()` so two 100 GB uploads never run
   * concurrent downloads on the same disk.
   */
  async processUploadCompletionJob(
    job: UploadCompletionJob
  ): Promise<
    { kind: 'created'; mediaId: number } | { kind: 'duplicate'; existingMediaId: number }
  > {
    return postProcessSemaphore.run(async () => {
      const db = await getDatabase();
      const mediaType = this.getMediaType(job.mime_type);

      // Validate folder ASAP — cheap lookup that avoids doing all the
      // heavy work if the target folder is gone.
      if (job.folder_id != null) {
        const folder = await db.getMediaFolderById(job.folder_id);
        if (!folder) {
          await storageService.deleteFile(job.storage_key).catch(() => {});
          throw new AppError(
            ErrorCode.FOLDER_NOT_FOUND,
            `Folder with ID ${job.folder_id} not found`,
            404
          );
        }
      }

      // Stage one local copy of the file. downloadToTemp streams to disk
      // so RSS stays constant; for local backend this is just a filesystem
      // path (no copy). We reuse the same temp file for checksum AND
      // ffprobe so we only pay the S3 download cost once.
      let localPath: string | null = null;
      let createdTemp = false;
      try {
        if (config.storage.backend === 'spaces') {
          localPath = await storageService.downloadToTemp(job.storage_key);
          createdTemp = true;
        } else {
          localPath = storageService.getFullPath(job.storage_key);
        }

        // Checksum first so we can short-circuit duplicates before running
        // ffprobe (which can itself take a minute on a long video).
        const checksum = await calculateFileChecksumStream(localPath);
        logger.info(`Upload job ${job.id} (${job.original_filename}): checksum=${checksum}`);

        const existing = await db.getMediaByChecksum(checksum);
        if (existing) {
          await storageService.deleteFile(job.storage_key).catch(() => {});
          logger.info(`Upload job ${job.id}: duplicate of media ${existing.id}, discarded`);
          return { kind: 'duplicate' as const, existingMediaId: existing.id };
        }

        // Not a duplicate — extract metadata.
        let metadata: MediaMetadata = {};
        let embeddedSubtitles: EmbeddedSubtitleStream[] = [];
        try {
          if (mediaType === 'video') {
            const result = await this.extractVideoMetadata(localPath);
            metadata = result.metadata;
            embeddedSubtitles = result.subtitles;
          } else if (mediaType === 'image') {
            metadata = await this.extractImageMetadata(localPath);
          }
        } catch (error) {
          // Non-fatal: still create the row with null width/height/duration.
          logger.warn(`Failed to extract metadata for ${job.original_filename}:`, error);
        }

        const input: CreateMediaInput = {
          filename: path.basename(job.storage_key),
          original_filename: job.original_filename,
          filepath: job.storage_key,
          type: mediaType,
          mime_type: job.mime_type,
          file_size: job.total_size,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          checksum,
          folder_id: job.folder_id,
        };
        const media = await db.createMedia(input);

        if (embeddedSubtitles.length > 0) {
          await this.persistEmbeddedSubtitles(media.id, embeddedSubtitles);
        }

        void this.enqueueThumbnail(media.id);
        this.fireApprovalNeededIfPending(media);

        logger.info(`Upload job ${job.id}: created media ${media.id} (${media.filename})`);
        return { kind: 'created' as const, mediaId: media.id };
      } finally {
        if (createdTemp && localPath) {
          const fsp = await import('fs/promises');
          await fsp.unlink(localPath).catch(() => {});
        }
      }
    });
  }

  /**
   * Upsert embedded subtitle tracks for a media file based on ffprobe output.
   * Kept private because call sites should always pair this with a successful
   * media-row insert — orphan subtitle rows would be created otherwise.
   */
  private async persistEmbeddedSubtitles(
    mediaId: number,
    streams: EmbeddedSubtitleStream[]
  ): Promise<void> {
    const db = await getDatabase();
    try {
      for (const s of streams) {
        await db.createEmbeddedSubtitle({
          media_file_id: mediaId,
          stream_index: s.stream_index,
          codec: s.codec,
          language: s.language,
          label: s.label,
          is_default: s.is_default,
          is_forced: s.is_forced,
        });
      }
      // Remove any stale rows for streams that no longer exist (handles
      // re-upload of a variant with fewer subtitle tracks).
      await db.pruneEmbeddedSubtitles(
        mediaId,
        streams.map((s) => s.stream_index)
      );
      logger.info(`Registered ${streams.length} embedded subtitle track(s) for media ${mediaId}`);
    } catch (error) {
      // Don't fail the whole upload because subtitle metadata insert failed.
      logger.warn(`Failed to persist embedded subtitles for media ${mediaId}:`, error);
    }
  }

  private fireApprovalNeededIfPending(media: MediaFile): void {
    if (media.approval_status !== 'pending') return;
    notificationService
      .fireEvent('media_approval_needed', {
        media_id: media.id,
        filename: media.original_filename || media.filename,
        type: media.type,
        file_size: media.file_size,
      })
      .catch((err) => {
        logger.warn(
          `Failed to fire media_approval_needed for media ${media.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /**
   * Enqueue a thumbnail job for the given media. The actual work runs
   * in the background via `thumbnailQueueService`, which picks the job
   * up and calls `processThumbnailJob()` below. Never throws — if the
   * insert fails we just log; the worst case is a missing thumbnail.
   */
  async enqueueThumbnail(mediaId: number): Promise<void> {
    try {
      const db = await getDatabase();
      await db.enqueueThumbnailJob(mediaId);
    } catch (err) {
      logger.error(`Failed to enqueue thumbnail job for media ${mediaId}:`, err);
    }
  }

  /**
   * Do the actual thumbnail generation for one media item. Called by
   * `thumbnailQueueService` for each claimed job. Throws on failure so
   * the caller can mark the job 'failed' and record the error.
   *
   * Serialised globally by `thumbnailSemaphore` so bursts of queued jobs
   * don't stack concurrent ffmpeg forks / libvips buffers on top of
   * in-flight HTTP work on the main event loop.
   */
  async processThumbnailJob(mediaId: number): Promise<void> {
    return thumbnailSemaphore.run(async () => {
      const db = await getDatabase();
      const media = await db.getMediaById(mediaId);
      if (!media) throw new Error(`Media ${mediaId} not found`);

      await db.updateMedia(mediaId, {
        thumbnail_status: 'generating',
      } as Partial<CreateMediaInput>);

      // For video on Spaces, hand ffmpeg the public CDN/endpoint URL
      // directly — combined with `-ss <t>` before `-i`, ffmpeg issues
      // HTTP range reads and fetches only a few MB near the seek point,
      // avoiding a multi-GB re-download of the whole object. For images
      // we still need the full file locally because sharp/libvips can't
      // read from HTTP, and images are small enough that this is fine.
      let sourcePath: string;
      let needsCleanup = false;
      if (config.storage.backend === 'spaces') {
        if (media.type === 'video') {
          sourcePath = storageService.getStreamingSource(media.filepath);
        } else {
          sourcePath = await storageService.downloadToTemp(media.filepath);
          needsCleanup = true;
        }
      } else {
        sourcePath = storageService.getFullPath(media.filepath);
      }

      try {
        let thumbnailPath: string | null = null;
        if (media.type === 'video') {
          thumbnailPath = await this.generateVideoThumbnail(sourcePath, media.filename);
        } else if (media.type === 'image') {
          thumbnailPath = await this.generateImageThumbnail(sourcePath, media.filename);
        }

        if (thumbnailPath) {
          await db.updateMedia(mediaId, {
            thumbnail_status: 'generated',
          } as Partial<CreateMediaInput>);
          logger.info(`Thumbnail generated for media ${mediaId}: ${thumbnailPath}`);
        } else {
          await db.updateMedia(mediaId, {
            thumbnail_status: 'failed',
          } as Partial<CreateMediaInput>);
          throw new Error('Thumbnail generator returned null');
        }
      } catch (error) {
        // Mark the media row failed too, even though the queue also records
        // the error on the job — the UI reads media.thumbnail_status.
        try {
          await db.updateMedia(mediaId, {
            thumbnail_status: 'failed',
          } as Partial<CreateMediaInput>);
        } catch (updateError) {
          logger.error(
            `Failed to update thumbnail_status to failed for media ${mediaId}:`,
            updateError
          );
        }
        throw error;
      } finally {
        if (needsCleanup) {
          const fs = await import('fs/promises');
          await fs.unlink(sourcePath).catch(() => {});
        }
      }
    });
  }

  /**
   * Retries thumbnail generation for a failed media file.
   */
  async retryThumbnail(id: number): Promise<MediaFile> {
    const media = await this.getMediaById(id);

    if (media.thumbnail_status !== 'failed') {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Cannot retry thumbnail: current status is '${media.thumbnail_status}'`,
        400
      );
    }

    // The old THUMBNAIL_MAX_SOURCE_BYTES cap is gone: thumbnail generation
    // now runs in an isolated worker with its own heap cap, and for Spaces
    // videos ffmpeg does HTTP range reads against the CDN URL (fetches a
    // few MB near the seek point, not the whole file). A pathological
    // source can only kill its worker, not the server.

    const db = await getDatabase();
    await db.updateMedia(id, { thumbnail_status: 'pending' } as Partial<CreateMediaInput>);
    await this.enqueueThumbnail(id);

    return this.getMediaById(id);
  }

  /**
   * Gets a media file by ID
   */
  async getMediaById(id: number): Promise<MediaFile> {
    const db = await getDatabase();
    const media = await db.getMediaById(id);

    if (!media) {
      throw new AppError(ErrorCode.MEDIA_NOT_FOUND, `Media file with ID ${id} not found`, 404);
    }

    return media;
  }

  /**
   * Gets all media files with pagination and filters
   */
  async getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>> {
    const db = await getDatabase();
    return db.getAllMedia(pagination, filter);
  }

  /**
   * Deletes a media file
   */
  async deleteMedia(id: number): Promise<void> {
    const media = await this.getMediaById(id);

    const db = await getDatabase();

    // Delete from database first (this will fail if media is in use due to foreign keys)
    await db.deleteMedia(id);

    // Delete file from storage
    await storageService.deleteFile(media.filepath);

    // Try to delete thumbnail if exists
    const thumbnailPath = await storageService.getThumbnailPath(media.filename);
    if (thumbnailPath) {
      await storageService.deleteFile(thumbnailPath);
    }

    logger.info(`Media deleted: ${id} - ${media.filename}`);
  }

  /**
   * Gets the file path for a media file
   */
  async getMediaFilePath(id: number): Promise<string> {
    const media = await this.getMediaById(id);
    const fullPath = storageService.getFullPath(media.filepath);

    // Verify file exists
    if (!(await storageService.fileExists(media.filepath))) {
      throw new AppError(
        ErrorCode.MEDIA_NOT_FOUND,
        `Media file not found on disk: ${media.filename}`,
        404
      );
    }

    return fullPath;
  }

  /**
   * Lookup the thumbnail for a media file. Non-blocking: if the thumb
   * doesn't exist yet, enqueues a job and signals the caller to retry.
   *
   * Return shape:
   *   { kind: 'ready', path }    — thumbnail exists, serve it
   *   { kind: 'failed' }         — prior generation failed, UI shows retry
   *   { kind: 'pending' }        — job queued/enqueued, client should retry
   *
   * For Spaces, `path` is the S3 key (caller proxies or redirects).
   * For local, `path` is an absolute filesystem path.
   */
  async getMediaThumbnail(
    id: number
  ): Promise<{ kind: 'ready'; path: string } | { kind: 'failed' } | { kind: 'pending' }> {
    const media = await this.getMediaById(id);

    const existing = await storageService.getThumbnailPath(media.filename);
    if (existing) {
      const path =
        config.storage.backend === 'spaces' ? existing : storageService.getFullPath(existing);
      return { kind: 'ready', path };
    }

    // No thumbnail yet. 'failed' means a prior attempt hit a permanent
    // error — the UI surfaces a Retry button and should NOT re-enqueue
    // on every grid render, which would spin the worker on a bad file.
    if (media.thumbnail_status === 'failed') {
      return { kind: 'failed' };
    }

    // Make sure there's an outstanding job. If the latest job for this
    // media is already queued/running, don't pile up duplicates.
    const db = await getDatabase();
    const latest = await db.getLatestThumbnailJobForMedia(id);
    const alreadyInFlight = latest && (latest.state === 'queued' || latest.state === 'running');
    if (!alreadyInFlight) {
      await this.enqueueThumbnail(id);
    }
    return { kind: 'pending' };
  }

  /**
   * Gets media statistics
   */
  async getMediaStats(): Promise<{
    total: number;
    videos: number;
    images: number;
    totalSize: number;
  }> {
    const db = await getDatabase();
    const allMedia = await db.getAllMedia({ page: 1, limit: 10000 });

    const stats = {
      total: allMedia.pagination.total,
      videos: 0,
      images: 0,
      totalSize: 0,
    };

    allMedia.data.forEach((media) => {
      if (media.type === 'video') stats.videos += 1;
      if (media.type === 'image') stats.images += 1;
      stats.totalSize += media.file_size || 0;
    });

    return stats;
  }
}

// Export singleton instance
export const mediaService = new MediaService();
