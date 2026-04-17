/**
 * Shared concurrency caps for heavy post-upload processing.
 *
 * A completion of a large upload on Spaces backend triggers:
 *   1. chunked-upload.completeSpacesUpload  → downloads full file for checksum
 *   2. media.createMediaFromStorageInfo     → downloads again for metadata/ffprobe
 *   3. media.generateThumbnailAsync         → downloads again for thumbnail
 *
 * Three concurrent uploads of 500MB+ files OOM-killed the container
 * (docker exit 137). These semaphores serialise the heavy steps across
 * the whole process so parallel uploads still accept fast but the post-
 * processing doesn't pile up.
 *
 * Override via env:
 *   MEDIA_POSTPROCESS_CONCURRENCY  (default 1) — checksum + metadata
 *   MEDIA_THUMBNAIL_CONCURRENCY    (default 1) — thumbnail generation
 */

import { Semaphore } from '../utils/semaphore';

const postProcessMax = Math.max(1, parseInt(process.env.MEDIA_POSTPROCESS_CONCURRENCY || '1', 10));
const thumbnailMax = Math.max(1, parseInt(process.env.MEDIA_THUMBNAIL_CONCURRENCY || '1', 10));

export const postProcessSemaphore = new Semaphore(postProcessMax);
export const thumbnailSemaphore = new Semaphore(thumbnailMax);
