import { BaseModel } from './BaseModel';
import { 
    Playlist, 
    PlaylistRow, 
    CreatePlaylistInput, 
    UpdatePlaylistInput,
    PlaylistItem 
} from '../../shared/types/models';
import { PlaylistItemModel } from './PlaylistItemModel';

export class PlaylistModel extends BaseModel {
    private static readonly TABLE_NAME = 'playlists';
    private static readonly DATE_FIELDS = ['created_at', 'updated_at'];

    static async create(input: CreatePlaylistInput): Promise<Playlist> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        const sql = `
            INSERT INTO ${this.TABLE_NAME} (id, name, description, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
        `;
        
        await this.runQuery(sql, [id, input.name, input.description || null, now, now]);
        
        const playlist = await this.findById(id);
        if (!playlist) {
            throw new Error('Failed to create playlist');
        }
        
        return playlist;
    }

    static async findById(id: string, includeItems: boolean = false): Promise<Playlist | null> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} WHERE id = ?`;
        const row = await this.getQuery<PlaylistRow>(sql, [id]);
        
        if (!row) {
            return null;
        }
        
        const playlist = this.convertRowToModel<Playlist>(row, this.DATE_FIELDS);
        
        if (includeItems) {
            playlist.items = await PlaylistItemModel.findByPlaylistId(id);
        }
        
        return playlist;
    }

    static async findAll(includeItems: boolean = false): Promise<Playlist[]> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} ORDER BY updated_at DESC`;
        const rows = await this.allQuery<PlaylistRow>(sql);
        
        const playlists = this.convertRowsToModels<Playlist>(rows, this.DATE_FIELDS);
        
        if (includeItems) {
            for (const playlist of playlists) {
                playlist.items = await PlaylistItemModel.findByPlaylistId(playlist.id);
            }
        }
        
        return playlists;
    }

    static async update(id: string, input: UpdatePlaylistInput): Promise<Playlist | null> {
        const updates: string[] = [];
        const params: any[] = [];
        
        if (input.name !== undefined) {
            updates.push('name = ?');
            params.push(input.name);
        }
        
        if (input.description !== undefined) {
            updates.push('description = ?');
            params.push(input.description);
        }
        
        if (updates.length === 0) {
            return this.findById(id);
        }
        
        updates.push('updated_at = ?');
        params.push(new Date().toISOString());
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
            console.error('Error deleting playlist:', error);
            return false;
        }
    }

    static async exists(id: string): Promise<boolean> {
        const sql = `SELECT 1 FROM ${this.TABLE_NAME} WHERE id = ? LIMIT 1`;
        const result = await this.getQuery(sql, [id]);
        return !!result;
    }

    static async search(query: string): Promise<Playlist[]> {
        const sql = `
            SELECT * FROM ${this.TABLE_NAME} 
            WHERE name LIKE ? OR description LIKE ?
            ORDER BY updated_at DESC
        `;
        const searchTerm = `%${query}%`;
        const rows = await this.allQuery<PlaylistRow>(sql, [searchTerm, searchTerm]);
        
        return this.convertRowsToModels<Playlist>(rows, this.DATE_FIELDS);
    }
}