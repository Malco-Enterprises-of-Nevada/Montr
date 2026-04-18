/**
 * Subtitle Service
 *
 * Handles upload, validation, and persistence of external subtitle files.
 * Detects format (SRT vs VTT) by content inspection rather than MIME type
 * (browsers routinely send SRT as application/octet-stream). Normalizes
 * encoding to UTF-8 and strips byte-order marks so downstream consumers
 * (including the Rust client's mpv subprocess) don't have to cope with
 * Windows-1252 or UTF-16 files.
 */

import path from 'path';
import { getDatabase } from '../database/connection';
import { storageService } from './storage.service';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { getLogger } from '../utils/logger';
import {
  SubtitleTrack,
  SubtitleFormat,
  CreateExternalSubtitleInput,
  UpdateSubtitleInput,
} from '../database/types';

const logger = getLogger();

const ACCEPTED_EXTENSIONS = new Set(['.srt', '.vtt']);
const MAX_SUBTITLE_SIZE = 10 * 1024 * 1024; // 10 MB — plenty for any real subtitle

/** SRT cue timestamps: `00:00:03,400 --> 00:00:05,100` (comma or dot for ms). */
const SRT_TIMESTAMP_REGEX = /\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/;

export interface SubtitleUploadOptions {
  mediaFileId: number;
  originalFilename: string;
  buffer: Buffer;
  language?: string | null;
  label?: string | null;
  isDefault?: boolean;
  isForced?: boolean;
}

export class SubtitleService {
  /**
   * Normalize a raw upload buffer to UTF-8 text. Strips UTF-8 and UTF-16 BOMs
   * and does a best-effort decode. We keep this dependency-free — jschardet
   * is not a hard requirement and the vast majority of real-world subtitles
   * are UTF-8 or Latin-1 already.
   */
  private normalizeToUtf8(buffer: Buffer): string {
    // UTF-16 LE BOM
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.slice(2).toString('utf16le');
    }
    // UTF-16 BE BOM — Node has no native decoder; swap bytes and decode as LE.
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      const swapped = Buffer.alloc(buffer.length - 2);
      for (let i = 2; i < buffer.length; i += 2) {
        swapped[i - 2] = buffer[i + 1];
        swapped[i - 1] = buffer[i];
      }
      return swapped.toString('utf16le');
    }
    // UTF-8 BOM
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return buffer.slice(3).toString('utf8');
    }
    return buffer.toString('utf8');
  }

  /**
   * Detect the subtitle format from the file content. Returns null if the
   * content does not match SRT or VTT. Callers should reject in that case.
   */
  private detectFormat(text: string): SubtitleFormat | null {
    const head = text.slice(0, 4096);
    // VTT: first non-empty line must start with WEBVTT
    const firstLine = head.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
    if (firstLine.trim().startsWith('WEBVTT')) {
      return 'vtt';
    }
    // SRT: must contain at least one timestamp cue
    if (SRT_TIMESTAMP_REGEX.test(head)) {
      return 'srt';
    }
    return null;
  }

  /**
   * Validate + persist an external subtitle file against a parent video.
   */
  async attachExternal(options: SubtitleUploadOptions): Promise<SubtitleTrack> {
    const { mediaFileId, originalFilename, buffer } = options;

    if (buffer.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Subtitle file is empty', 400);
    }
    if (buffer.length > MAX_SUBTITLE_SIZE) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Subtitle file exceeds ${MAX_SUBTITLE_SIZE} bytes`,
        400
      );
    }

    const ext = path.extname(originalFilename).toLowerCase();
    if (!ACCEPTED_EXTENSIONS.has(ext)) {
      throw new AppError(
        ErrorCode.INVALID_MEDIA_TYPE,
        `Unsupported subtitle extension: ${ext}. Allowed: .srt, .vtt`,
        400
      );
    }

    const db = await getDatabase();
    const parent = await db.getMediaById(mediaFileId);
    if (!parent) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Media ${mediaFileId} not found`, 404);
    }
    if (parent.type !== 'video') {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'Subtitles can only be attached to video media',
        400
      );
    }

    const text = this.normalizeToUtf8(buffer);
    const detectedFormat = this.detectFormat(text);
    if (!detectedFormat) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'File content does not look like a valid SRT or VTT subtitle',
        400
      );
    }

    const extFormat = ext === '.vtt' ? 'vtt' : 'srt';
    if (detectedFormat !== extFormat) {
      // Extension and content disagree — trust content, log mismatch.
      logger.warn(
        `Subtitle extension/content mismatch: ext=${ext}, detected=${detectedFormat}, file=${originalFilename}`
      );
    }

    const normalizedBuffer = Buffer.from(text, 'utf8');
    const storageInfo = await storageService.saveSubtitle(
      normalizedBuffer,
      originalFilename,
      detectedFormat
    );

    const input: CreateExternalSubtitleInput = {
      media_file_id: mediaFileId,
      storage_filename: storageInfo.filepath,
      original_filename: originalFilename,
      format: detectedFormat,
      size_bytes: storageInfo.size,
      checksum: storageInfo.checksum,
      language: options.language ?? null,
      label: options.label ?? null,
      is_default: !!options.isDefault,
      is_forced: !!options.isForced,
    };

    try {
      return await db.createExternalSubtitle(input);
    } catch (error) {
      // If DB insert fails, don't orphan the file on disk.
      await storageService.deleteFile(storageInfo.filepath).catch(() => undefined);
      throw error;
    }
  }

  async list(mediaFileId: number): Promise<SubtitleTrack[]> {
    const db = await getDatabase();
    return db.getSubtitlesForMedia(mediaFileId);
  }

  async getById(id: number): Promise<SubtitleTrack> {
    const db = await getDatabase();
    const row = await db.getSubtitleById(id);
    if (!row) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Subtitle ${id} not found`, 404);
    }
    return row;
  }

  async update(id: number, input: UpdateSubtitleInput): Promise<SubtitleTrack> {
    const db = await getDatabase();
    await this.getById(id);
    return db.updateSubtitle(id, input);
  }

  async delete(id: number): Promise<void> {
    const db = await getDatabase();
    const row = await this.getById(id);
    // For external subs, unlink the stored file before dropping the row.
    if (row.kind === 'external' && row.storage_filename) {
      await storageService.deleteFile(row.storage_filename).catch((err) => {
        logger.warn(`Failed to delete subtitle file ${row.storage_filename}:`, err);
      });
    }
    await db.deleteSubtitle(id);
  }
}

export const subtitleService = new SubtitleService();
