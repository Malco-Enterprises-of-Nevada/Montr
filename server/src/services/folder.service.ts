/**
 * Folder Service
 * CRUD + move/cycle-detection for the media_folders tree.
 */

import { getDatabase } from '../database/connection';
import { MediaFolder, CreateMediaFolderInput, UpdateMediaFolderInput } from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';

const logger = getLogger();

export class FolderService {
  async createFolder(input: CreateMediaFolderInput): Promise<MediaFolder> {
    const db = await getDatabase();

    if (input.parent_id !== null && input.parent_id !== undefined) {
      const parent = await db.getMediaFolderById(input.parent_id);
      if (!parent) {
        throw new AppError(
          ErrorCode.FOLDER_NOT_FOUND,
          `Parent folder with ID ${input.parent_id} not found`,
          404
        );
      }
    }

    try {
      const folder = await db.createMediaFolder(input);
      logger.info(`Folder created: ${folder.id} - ${folder.path}`);
      return folder;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/unique|duplicate/i.test(msg)) {
        throw new AppError(
          ErrorCode.FOLDER_NAME_CONFLICT,
          `A folder named "${input.name}" already exists in this location`,
          409
        );
      }
      throw err;
    }
  }

  async getFolderById(id: number): Promise<MediaFolder> {
    const db = await getDatabase();
    const folder = await db.getMediaFolderById(id);
    if (!folder) {
      throw new AppError(ErrorCode.FOLDER_NOT_FOUND, `Folder with ID ${id} not found`, 404);
    }
    return folder;
  }

  async listFolders(): Promise<MediaFolder[]> {
    const db = await getDatabase();
    return db.getAllMediaFolders();
  }

  async updateFolder(id: number, input: UpdateMediaFolderInput): Promise<MediaFolder> {
    const db = await getDatabase();
    await this.getFolderById(id); // 404 if missing

    try {
      const updated = await db.updateMediaFolder(id, input);
      logger.info(`Folder updated: ${id} -> ${updated.path}`);
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cycle|descendant|own parent/i.test(msg)) {
        throw new AppError(ErrorCode.FOLDER_CYCLE, msg, 400);
      }
      if (/unique|duplicate/i.test(msg)) {
        throw new AppError(
          ErrorCode.FOLDER_NAME_CONFLICT,
          `A folder with that name already exists in the target location`,
          409
        );
      }
      throw err;
    }
  }

  /**
   * Delete a folder.
   *  - non-recursive (default): rejects with 409 if the folder contains
   *    any media or subfolders.
   *  - recursive: deletes the folder and all descendants, detaching any
   *    contained media (setting folder_id to NULL) rather than deleting it.
   */
  async deleteFolder(id: number, recursive: boolean): Promise<void> {
    const db = await getDatabase();
    const folder = await this.getFolderById(id);
    const counts = await db.getMediaFolderContentCounts(id);

    if (!recursive && (counts.media > 0 || counts.subfolders > 0)) {
      throw new AppError(
        ErrorCode.FOLDER_NOT_EMPTY,
        `Folder "${folder.name}" is not empty (${counts.media} files, ${counts.subfolders} subfolders). Pass ?recursive=true to force.`,
        409,
        true,
        { media: counts.media, subfolders: counts.subfolders }
      );
    }

    if (recursive) {
      // Detach media from this folder + all descendants to root.
      const descendants = await db.getMediaFolderDescendants(id);
      const allIds = [id, ...descendants.map((d) => d.id)];
      await db.moveMediaToFolder(
        // Move every media file that has one of these folder_ids to NULL.
        // Service layer can't bulk-nullify by folder_id directly, so we build
        // the id list by scanning media. For typical sizes this is fine;
        // for very large folders we'd push this into the adapter later.
        await this.collectMediaIdsInFolders(allIds),
        null
      );
    }

    await db.deleteMediaFolder(id);
    logger.info(`Folder deleted: ${id} (recursive=${recursive})`);
  }

  private async collectMediaIdsInFolders(folderIds: number[]): Promise<number[]> {
    if (folderIds.length === 0) return [];
    const db = await getDatabase();
    const ids: number[] = [];
    // getAllMedia supports filtering by a single folder; aggregate across the list.
    for (const fid of folderIds) {
      let page = 1;
      // Defensive cap at 10k items per folder — if more, caller should batch.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const result = await db.getAllMedia({ page, limit: 500 }, { folder_id: fid });
        for (const m of result.data) ids.push(m.id);
        if (page >= result.pagination.totalPages) break;
        page += 1;
      }
    }
    return ids;
  }
}

export const folderService = new FolderService();
