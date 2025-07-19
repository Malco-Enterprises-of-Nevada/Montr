import { BaseModel } from './BaseModel';
import { SystemState, SystemStateRow } from '../../shared/types/models';

export class SystemStateModel extends BaseModel {
    private static readonly TABLE_NAME = 'system_state';
    private static readonly DATE_FIELDS = ['updated_at'];

    static async get(key: string): Promise<string | null> {
        const sql = `SELECT value FROM ${this.TABLE_NAME} WHERE key = ?`;
        const result = await this.getQuery<{ value: string | null }>(sql, [key]);
        return result?.value || null;
    }

    static async set(key: string, value: string | null): Promise<void> {
        const sql = `
            INSERT INTO ${this.TABLE_NAME} (key, value, updated_at) 
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET 
                value = excluded.value,
                updated_at = excluded.updated_at
        `;
        
        await this.runQuery(sql, [key, value, new Date().toISOString()]);
    }

    static async getAll(): Promise<SystemState[]> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} ORDER BY key`;
        const rows = await this.allQuery<SystemStateRow>(sql);
        return this.convertRowsToModels<SystemState>(rows, this.DATE_FIELDS);
    }

    static async delete(key: string): Promise<boolean> {
        const sql = `DELETE FROM ${this.TABLE_NAME} WHERE key = ?`;
        
        try {
            await this.runQuery(sql, [key]);
            return true;
        } catch (error) {
            console.error('Error deleting system state:', error);
            return false;
        }
    }

    // Specific methods for common system state keys
    static async getActivePlaylistId(): Promise<string | null> {
        return this.get('active_playlist_id');
    }

    static async setActivePlaylistId(playlistId: string | null): Promise<void> {
        await this.set('active_playlist_id', playlistId);
    }

    static async clearActivePlaylist(): Promise<void> {
        await this.setActivePlaylistId(null);
    }

    static async exists(key: string): Promise<boolean> {
        const sql = `SELECT 1 FROM ${this.TABLE_NAME} WHERE key = ? LIMIT 1`;
        const result = await this.getQuery(sql, [key]);
        return !!result;
    }

    static async getLastUpdated(key: string): Promise<Date | null> {
        const sql = `SELECT updated_at FROM ${this.TABLE_NAME} WHERE key = ?`;
        const result = await this.getQuery<{ updated_at: string }>(sql, [key]);
        
        if (!result) {
            return null;
        }
        
        return new Date(result.updated_at);
    }
}