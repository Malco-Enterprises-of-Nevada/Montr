/**
 * Integration tests for Folder Routes
 */

import request from 'supertest';
import { Application } from 'express';
import MontrServer from '../../../src/index';
import { getDatabase } from '../../../src/database/connection';
import { createMockDatabase, createPaginatedResult } from '../../utils/database.mock';
import { expectSuccessResponse, expectErrorResponse } from '../../utils/test-helpers';
import { MediaFolder } from '../../../src/database/types';

jest.mock('../../../src/database/connection');

const mockFolder = (overrides?: Partial<MediaFolder>): MediaFolder => ({
  id: 1,
  name: 'Ads',
  parent_id: null,
  path: '/1',
  created_by: null,
  created_at: '2026-04-16T10:00:00.000Z',
  updated_at: '2026-04-16T10:00:00.000Z',
  ...overrides,
});

describe('Folder Routes Integration Tests', () => {
  let app: Application;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeAll(() => {
    const server = new MontrServer();
    app = server.getApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('GET /api/folders', () => {
    it('returns a flat list of folders', async () => {
      const folders = [
        mockFolder({ id: 1, name: 'Ads', path: '/1' }),
        mockFolder({ id: 2, name: 'Q2-2026', parent_id: 1, path: '/1/2' }),
      ];
      mockDb.getAllMediaFolders.mockResolvedValue(folders);

      const response = await request(app).get('/api/folders');

      const data = expectSuccessResponse<MediaFolder[]>(response);
      expect(data).toHaveLength(2);
      expect(data[1].parent_id).toBe(1);
    });
  });

  describe('POST /api/folders', () => {
    it('creates a root folder', async () => {
      const folder = mockFolder();
      mockDb.createMediaFolder.mockResolvedValue(folder);

      const response = await request(app)
        .post('/api/folders')
        .send({ name: 'Ads' });

      const data = expectSuccessResponse<MediaFolder>(response, 201);
      expect(data.id).toBe(1);
      expect(mockDb.createMediaFolder).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Ads', parent_id: null })
      );
    });

    it('creates a nested folder when parent exists', async () => {
      const parent = mockFolder({ id: 1 });
      const child = mockFolder({ id: 2, name: 'Q2-2026', parent_id: 1, path: '/1/2' });
      mockDb.getMediaFolderById.mockResolvedValue(parent);
      mockDb.createMediaFolder.mockResolvedValue(child);

      const response = await request(app)
        .post('/api/folders')
        .send({ name: 'Q2-2026', parent_id: 1 });

      const data = expectSuccessResponse<MediaFolder>(response, 201);
      expect(data.parent_id).toBe(1);
    });

    it('returns 404 when parent does not exist', async () => {
      mockDb.getMediaFolderById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/folders')
        .send({ name: 'Orphan', parent_id: 999 });

      expectErrorResponse(response, 404, 'FOLDER_NOT_FOUND');
    });

    it('rejects names with slashes', async () => {
      const response = await request(app)
        .post('/api/folders')
        .send({ name: 'bad/name' });

      expectErrorResponse(response, 400, 'VALIDATION_ERROR');
    });

    it('surfaces sibling-name conflicts as 409', async () => {
      mockDb.createMediaFolder.mockRejectedValue(
        new Error('UNIQUE constraint failed: media_folders.parent_id, media_folders.name')
      );

      const response = await request(app)
        .post('/api/folders')
        .send({ name: 'Ads' });

      expectErrorResponse(response, 409, 'FOLDER_NAME_CONFLICT');
    });
  });

  describe('PATCH /api/folders/:id', () => {
    it('renames a folder', async () => {
      const folder = mockFolder({ name: 'Old' });
      const renamed = mockFolder({ name: 'New' });
      mockDb.getMediaFolderById.mockResolvedValue(folder);
      mockDb.updateMediaFolder.mockResolvedValue(renamed);

      const response = await request(app)
        .patch('/api/folders/1')
        .send({ name: 'New' });

      const data = expectSuccessResponse<MediaFolder>(response);
      expect(data.name).toBe('New');
    });

    it('returns FOLDER_CYCLE when moving into a descendant', async () => {
      const folder = mockFolder({ id: 1 });
      mockDb.getMediaFolderById.mockResolvedValue(folder);
      mockDb.updateMediaFolder.mockRejectedValue(
        new Error('Cannot move folder into its own descendant')
      );

      const response = await request(app)
        .patch('/api/folders/1')
        .send({ parent_id: 2 });

      expectErrorResponse(response, 400, 'FOLDER_CYCLE');
    });
  });

  describe('DELETE /api/folders/:id', () => {
    it('rejects deletion of a non-empty folder without ?recursive', async () => {
      const folder = mockFolder();
      mockDb.getMediaFolderById.mockResolvedValue(folder);
      mockDb.getMediaFolderContentCounts.mockResolvedValue({ media: 3, subfolders: 1 });

      const response = await request(app).delete('/api/folders/1');

      expectErrorResponse(response, 409, 'FOLDER_NOT_EMPTY');
      expect(mockDb.deleteMediaFolder).not.toHaveBeenCalled();
    });

    it('allows recursive deletion and detaches contained media to root', async () => {
      const folder = mockFolder();
      mockDb.getMediaFolderById.mockResolvedValue(folder);
      mockDb.getMediaFolderContentCounts.mockResolvedValue({ media: 2, subfolders: 0 });
      mockDb.getMediaFolderDescendants.mockResolvedValue([]);
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([], 1, 500));

      const response = await request(app).delete('/api/folders/1?recursive=true');

      expectSuccessResponse(response);
      expect(mockDb.deleteMediaFolder).toHaveBeenCalledWith(1);
    });

    it('deletes an empty folder without ?recursive', async () => {
      const folder = mockFolder();
      mockDb.getMediaFolderById.mockResolvedValue(folder);
      mockDb.getMediaFolderContentCounts.mockResolvedValue({ media: 0, subfolders: 0 });

      const response = await request(app).delete('/api/folders/1');

      expectSuccessResponse(response);
      expect(mockDb.deleteMediaFolder).toHaveBeenCalledWith(1);
    });
  });

  describe('GET /api/folders/:id/media', () => {
    it('lists media filtered to the folder', async () => {
      const folder = mockFolder();
      mockDb.getMediaFolderById.mockResolvedValue(folder);
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([]));

      const response = await request(app).get('/api/folders/1/media');

      expectSuccessResponse(response);
      expect(mockDb.getAllMedia).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ folder_id: 1 })
      );
    });

    it('returns 404 when the folder is missing', async () => {
      mockDb.getMediaFolderById.mockResolvedValue(null);

      const response = await request(app).get('/api/folders/999/media');

      expectErrorResponse(response, 404, 'FOLDER_NOT_FOUND');
    });
  });
});
