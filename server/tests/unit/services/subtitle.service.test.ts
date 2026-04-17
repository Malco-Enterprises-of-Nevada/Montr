/**
 * Unit tests for SubtitleService
 *
 * Covers format sniffing, encoding normalization, and the parent-media
 * guardrails that protect us from orphan or mis-classified subtitle rows.
 */

import { SubtitleService } from '../../../src/services/subtitle.service';
import { storageService } from '../../../src/services/storage.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError, ErrorCode } from '../../../src/api/middleware/error-handler';
import { createMockDatabase } from '../../utils/database.mock';
import { mockVideoFile, mockImageFile } from '../../fixtures/media.fixtures';
import { SubtitleTrack } from '../../../src/database/types';

jest.mock('../../../src/database/connection');
jest.mock('../../../src/services/storage.service');

const SRT_SAMPLE = `1
00:00:01,000 --> 00:00:03,500
Hello, world.

2
00:00:04,000 --> 00:00:06,000
Testing subtitle parsing.
`;

const VTT_SAMPLE = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello, world.

2
00:00:04.000 --> 00:00:06.000
Testing subtitle parsing.
`;

const MALFORMED = `This is not a subtitle file at all.
Just plain prose with no timestamps.`;

describe('SubtitleService', () => {
  let subtitleService: SubtitleService;
  let mockDb: ReturnType<typeof createMockDatabase>;

  const stubStorageSave = (storageFilename: string, checksum = 'cs123') => {
    (storageService.saveSubtitle as jest.Mock) = jest.fn().mockResolvedValue({
      filename: storageFilename.split('/').pop(),
      filepath: storageFilename,
      checksum,
      size: 1024,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    subtitleService = new SubtitleService();

    (storageService.deleteFile as jest.Mock) = jest.fn().mockResolvedValue(undefined);
    stubStorageSave('subtitles/uuid.srt');
  });

  describe('attachExternal', () => {
    const createInput = (overrides: Partial<{ buffer: Buffer; filename: string }> = {}) => ({
      mediaFileId: mockVideoFile.id,
      originalFilename: overrides.filename ?? 'test.srt',
      buffer: overrides.buffer ?? Buffer.from(SRT_SAMPLE, 'utf8'),
    });

    beforeEach(() => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.createExternalSubtitle.mockImplementation(
        async (input) =>
          ({
            id: 42,
            media_file_id: input.media_file_id,
            kind: 'external',
            storage_filename: input.storage_filename,
            original_filename: input.original_filename,
            format: input.format,
            size_bytes: input.size_bytes,
            checksum: input.checksum,
            stream_index: null,
            codec: null,
            language: input.language ?? null,
            label: input.label ?? null,
            is_default: !!input.is_default,
            is_forced: !!input.is_forced,
            created_at: new Date().toISOString(),
          }) as SubtitleTrack
      );
    });

    it('accepts a valid SRT upload', async () => {
      const track = await subtitleService.attachExternal(createInput());
      expect(track.format).toBe('srt');
      expect(storageService.saveSubtitle).toHaveBeenCalledWith(
        expect.any(Buffer),
        'test.srt',
        'srt'
      );
      expect(mockDb.createExternalSubtitle).toHaveBeenCalled();
    });

    it('accepts a valid VTT upload', async () => {
      const track = await subtitleService.attachExternal(
        createInput({ buffer: Buffer.from(VTT_SAMPLE, 'utf8'), filename: 'test.vtt' })
      );
      expect(track.format).toBe('vtt');
      expect(storageService.saveSubtitle).toHaveBeenCalledWith(
        expect.any(Buffer),
        'test.vtt',
        'vtt'
      );
    });

    it('strips a UTF-8 BOM before saving', async () => {
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const input = createInput({ buffer: Buffer.concat([bom, Buffer.from(SRT_SAMPLE, 'utf8')]) });
      await subtitleService.attachExternal(input);
      const savedBuf = (storageService.saveSubtitle as jest.Mock).mock.calls[0][0] as Buffer;
      expect(savedBuf[0]).not.toBe(0xef);
      expect(savedBuf.toString('utf8')).toContain('Hello, world.');
    });

    it('decodes a UTF-16 LE BOM-prefixed SRT', async () => {
      const bom = Buffer.from([0xff, 0xfe]);
      const utf16 = Buffer.from(SRT_SAMPLE, 'utf16le');
      const input = createInput({ buffer: Buffer.concat([bom, utf16]) });
      const track = await subtitleService.attachExternal(input);
      expect(track.format).toBe('srt');
    });

    it('rejects an empty file', async () => {
      await expect(
        subtitleService.attachExternal(createInput({ buffer: Buffer.alloc(0) }))
      ).rejects.toThrow(AppError);
    });

    it('rejects content that does not look like SRT or VTT', async () => {
      try {
        await subtitleService.attachExternal(
          createInput({ buffer: Buffer.from(MALFORMED, 'utf8') })
        );
        fail('Expected attach to reject malformed content');
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).code).toBe(ErrorCode.BAD_REQUEST);
      }
    });

    it('rejects unsupported extensions before sniffing content', async () => {
      try {
        await subtitleService.attachExternal(
          createInput({ filename: 'foo.ass', buffer: Buffer.from(SRT_SAMPLE, 'utf8') })
        );
        fail('Expected attach to reject .ass extension');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.INVALID_MEDIA_TYPE);
      }
    });

    it('rejects when the parent media is an image, not a video', async () => {
      mockDb.getMediaById.mockResolvedValue(mockImageFile);
      try {
        await subtitleService.attachExternal({
          ...createInput(),
          mediaFileId: mockImageFile.id,
        });
        fail('Expected attach to reject non-video parent');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.BAD_REQUEST);
      }
    });

    it('rejects when the parent media is missing entirely', async () => {
      mockDb.getMediaById.mockResolvedValue(null);
      try {
        await subtitleService.attachExternal(createInput());
        fail('Expected 404 on missing parent');
      } catch (e) {
        expect((e as AppError).code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      }
    });

    it('cleans up the stored file if the DB insert fails', async () => {
      mockDb.createExternalSubtitle.mockRejectedValueOnce(new Error('db down'));
      await expect(subtitleService.attachExternal(createInput())).rejects.toThrow('db down');
      expect(storageService.deleteFile).toHaveBeenCalledWith('subtitles/uuid.srt');
    });
  });

  describe('delete', () => {
    it('unlinks the stored file for an external subtitle before dropping the DB row', async () => {
      mockDb.getSubtitleById.mockResolvedValue({
        id: 99,
        media_file_id: 1,
        kind: 'external',
        storage_filename: 'subtitles/abc.srt',
        original_filename: 'abc.srt',
        format: 'srt',
        size_bytes: 1024,
        checksum: 'cs',
        stream_index: null,
        codec: null,
        language: 'eng',
        label: null,
        is_default: true,
        is_forced: false,
        created_at: new Date().toISOString(),
      } as SubtitleTrack);

      await subtitleService.delete(99);
      expect(storageService.deleteFile).toHaveBeenCalledWith('subtitles/abc.srt');
      expect(mockDb.deleteSubtitle).toHaveBeenCalledWith(99);
    });

    it('skips the storage unlink for embedded subtitles', async () => {
      mockDb.getSubtitleById.mockResolvedValue({
        id: 100,
        media_file_id: 1,
        kind: 'embedded',
        storage_filename: null,
        original_filename: null,
        format: null,
        size_bytes: null,
        checksum: null,
        stream_index: 2,
        codec: 'subrip',
        language: 'eng',
        label: null,
        is_default: false,
        is_forced: false,
        created_at: new Date().toISOString(),
      } as SubtitleTrack);

      await subtitleService.delete(100);
      expect(storageService.deleteFile).not.toHaveBeenCalled();
      expect(mockDb.deleteSubtitle).toHaveBeenCalledWith(100);
    });
  });
});
