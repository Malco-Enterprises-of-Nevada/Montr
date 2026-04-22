/**
 * Unit tests for UploadCompletionQueueService.
 *
 * Mirrors the shape of media.service.test.ts's queue-adjacent tests — we
 * mock the database + mediaService and assert that each result kind
 * (`created` / `duplicate` / error) lands on the right adapter method.
 */

import { getDatabase } from '../../../src/database/connection';
import { mediaService } from '../../../src/services/media.service';
import { uploadCompletionQueueService } from '../../../src/services/upload-completion-queue.service';
import { createMockDatabase } from '../../utils/database.mock';

jest.mock('../../../src/database/connection');
jest.mock('../../../src/services/media.service', () => ({
  mediaService: {
    processUploadCompletionJob: jest.fn(),
  },
}));

describe('UploadCompletionQueueService', () => {
  let mockDb: ReturnType<typeof createMockDatabase>;

  const makeJob = () => ({
    id: 101,
    upload_id: 'u-1',
    storage_backend: 'spaces' as const,
    storage_key: 'media/foo.mp4',
    original_filename: 'foo.mp4',
    mime_type: 'video/mp4',
    total_size: 1024,
    folder_id: null,
    state: 'running' as const,
    attempts: 1,
    last_error: null,
    media_id: null,
    existing_media_id: null,
    created_at: '2026-04-22T00:00:00Z',
    updated_at: '2026-04-22T00:00:00Z',
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  // The service class is a singleton; we exercise the private runOne via
  // its public poll loop would be invasive. Instead we drive one iteration
  // by invoking the same contract the loop uses.
  async function runOne(): Promise<boolean> {
    const svc = uploadCompletionQueueService as unknown as {
      runOne: () => Promise<boolean>;
    };
    return svc.runOne();
  }

  it('returns false and calls nothing when queue is empty', async () => {
    mockDb.claimNextUploadCompletionJob.mockResolvedValue(null);

    const drained = await runOne();

    expect(drained).toBe(false);
    expect(mediaService.processUploadCompletionJob).not.toHaveBeenCalled();
    expect(mockDb.markUploadCompletionJobDone).not.toHaveBeenCalled();
    expect(mockDb.markUploadCompletionJobDuplicate).not.toHaveBeenCalled();
    expect(mockDb.markUploadCompletionJobFailed).not.toHaveBeenCalled();
  });

  it('marks Done when processUploadCompletionJob returns created', async () => {
    const job = makeJob();
    mockDb.claimNextUploadCompletionJob.mockResolvedValue(job);
    (mediaService.processUploadCompletionJob as jest.Mock).mockResolvedValue({
      kind: 'created',
      mediaId: 555,
    });

    await runOne();

    expect(mockDb.markUploadCompletionJobDone).toHaveBeenCalledWith(job.id, 555);
    expect(mockDb.markUploadCompletionJobDuplicate).not.toHaveBeenCalled();
    expect(mockDb.markUploadCompletionJobFailed).not.toHaveBeenCalled();
  });

  it('marks Duplicate when processUploadCompletionJob returns duplicate', async () => {
    const job = makeJob();
    mockDb.claimNextUploadCompletionJob.mockResolvedValue(job);
    (mediaService.processUploadCompletionJob as jest.Mock).mockResolvedValue({
      kind: 'duplicate',
      existingMediaId: 12,
    });

    await runOne();

    expect(mockDb.markUploadCompletionJobDuplicate).toHaveBeenCalledWith(job.id, 12);
    expect(mockDb.markUploadCompletionJobDone).not.toHaveBeenCalled();
    expect(mockDb.markUploadCompletionJobFailed).not.toHaveBeenCalled();
  });

  it('marks Failed with the error message when the worker throws', async () => {
    const job = makeJob();
    mockDb.claimNextUploadCompletionJob.mockResolvedValue(job);
    (mediaService.processUploadCompletionJob as jest.Mock).mockRejectedValue(
      new Error('ffprobe boom')
    );

    await runOne();

    expect(mockDb.markUploadCompletionJobFailed).toHaveBeenCalledWith(job.id, 'ffprobe boom');
    expect(mockDb.markUploadCompletionJobDone).not.toHaveBeenCalled();
    expect(mockDb.markUploadCompletionJobDuplicate).not.toHaveBeenCalled();
  });
});
