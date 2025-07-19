import { BaseModel } from './BaseModel';
import { 
    PlaylistItem, 
    PlaylistItemRow, 
    CreatePlaylistItemInput, 
    UpdatePlaylistItemInput,
    MediaFile
} from '../../shared/types/models';
import { MediaFileModel } from './MediaFileModel';

export class PlaylistItemModel extends BaseModel {
    private static readonly TABLE_NAME = 'playlist_items';

    static async create(input: CreatePlaylistItemInput): Promise<PlaylistItem> {
        const id = this.generateId();
        
        const sql = `
            INSERT INTO ${this.TABLE_NAME} (id, playlist_id, media_file_id, order_index, display_duration)
            VALUES (?, ?, ?, ?, ?)
        `;
        
        await this.runQuery(sql, [
            id,
            input.playlist_id,
            input.media_file_id,
            input.order_index,
            input.display_duration || null
        ]);
        
        const item = await this.findById(id);
        if (!item) {
            throw new Error('Failed to create playlist item');
        }
        
        return item;
    }

    static async findById(id: string, includeMediaFile: boolean = false): Promise<PlaylistItem | null> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} WHERE id = ?`;
        const row = await this.getQuery<PlaylistItemRow>(sql, [id]);
        
        if (!row) {
            return null;
        }
        
        const item = this.convertRowToModel<PlaylistItem>(row);
        
        if (includeMediaFile) {
            item.media_file = await MediaFileModel.findById(item.media_file_id);
        }
        
        return item;
    }

    static async findByPlaylistId(playlistId: string, includeMediaFiles: boolean = true): Promise<PlaylistItem[]> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} WHERE playlist_id = ? ORDER BY order_index ASC`;
        const rows = await this.allQuery<PlaylistItemRow>(sql, [playlistId]);
        
        const items = this.convertRowsToModels<PlaylistItem>(rows);
        
        if (includeMediaFiles) {
            for (const item of items) {
                item.media_file = await MediaFileModel.findById(item.media_file_id);
            }
        }
        
        return items;
    }

    static async update(id: string, input: UpdatePlaylistItemInput): Promise<PlaylistItem | null> {
        const updates: string[] = [];
        const params: any[] = [];
        
        if (input.order_index !== undefined) {
            updates.push('order_index = ?');
            params.push(input.order_index);
        }
        
        if (input.display_duration !== undefined) {
            updates.push('display_duration = ?');
            params.push(input.display_duration);
        }
        
        if (updates.length === 0) {
            return this.findById(id);
        }
        
        params.push(id);
        
        const sql = `UPDATE ${this.TABLE_NAME} SET ${updates.join(', ')} WHERE id = ?`;
        await this.runQuery(sql, params);
        
        return this.findById(id);
    }

    static async delete(id: string): Promise<boolean> {
        const sql = `DELETE FROM ${this.TABLE_NAME} WHERE id = ?`;
        
        try {
            await this.runQuery(sql, [id]);
            return true;
        } catch (error) {
            console.error('Error deleting playlist item:', error);
            return false;
        }
    }

    static async deleteByPlaylistId(playlistId: string): Promise<boolean> {
        const sql = `DELETE FROM ${this.TABLE_NAME} WHERE playlist_id = ?`;
        
        try {
            await this.runQuery(sql, [playlistId]);
            return true;
        } catch (error) {
            console.error('Error deleting playlist items:', error);
            return false;
        }
    }

    static async deleteByMediaFileId(mediaFileId: string): Promise<boolean> {
        const sql = `DELETE FROM ${this.TABLE_NAME} WHERE media_file_id = ?`;
        
        try {
            await this.runQuery(sql, [mediaFileId]);
            return true;
        } catch (error) {
            console.error('Error deleting playlist items by media file:', error);
            return false;
        }
    }

    static async reorderItems(playlistId: string, itemOrders: { id: string; order_index: number }[]): Promise<boolean> {
        try {
            // Update each item's order_index
            for (const item of itemOrders) {
                const sql = `UPDATE ${this.TABLE_NAME} SET order_index = ? WHERE id = ? AND playlist_id = ?`;
                await this.runQuery(sql, [item.order_index, item.id, playlistId]);
            }
            return true;
        } catch (error) {
            console.error('Error reordering playlist items:', error);
            return false;
        }
    }

    static async getNextOrderIndex(playlistId: string): Promise<number> {
        const sql = `SELECT MAX(order_index) as max_order FROM ${this.TABLE_NAME} WHERE playlist_id = ?`;
        const result = await this.getQuery<{ max_order: number | null }>(sql, [playlistId]);
        
        return (result?.max_order || 0) + 1;
    }

    static async exists(id: string): Promise<boolean> {
        const sql = `SELECT 1 FROM ${this.TABLE_NAME} WHERE id = ? LIMIT 1`;
        const result = await this.getQuery(sql, [id]);
        return !!result;
    }

    static async getPlaylistItemCount(playlistId: string): Promise<number> {
        const sql = `SELECT COUNT(*) as count FROM ${this.TABLE_NAME} WHERE playlist_id = ?`;
        const result = await this.getQuery<{ count: number }>(sql, [playlistId]);
        return result?.count || 0;
    }
}