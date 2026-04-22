/**
 * Streaming checksum helpers — share between the chunked-upload finaliser
 * and the upload-completion queue worker so both paths produce the same
 * hex digest from the same bytes.
 */

import crypto from 'crypto';
import { createReadStream } from 'fs';

/**
 * SHA-256 of a file, computed incrementally via readable stream so RSS
 * stays near constant regardless of file size (safe for 100 GB inputs).
 */
export function calculateFileChecksumStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
