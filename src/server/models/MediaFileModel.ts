import { BaseModel } from './BaseModel';
import { 
    MediaFile, 
    MediaFileRow, 
    CreateMediaFileInput 
} from '../../shared/types/models';

export class MediaFileModel extends BaseModel {
    private static readonly TABLE_NAME = 'media_files';
    private static readonly DATE_FIELDS = ['created_at'];

    static async create(input: CreateMediaFileInput): Promise<MediaFile> {
        const id = this.generateId();
        const now = new Date().toISOString();
        
        const sql = `
            INSERT INTO ${this.TABLE_NAME} 
            (id, filename, original_name, file_type, mime_type, file_size, duration, thumbnail_path, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        await this.runQuery(sql, [
            id,
            input.filename,
            input.original_name,
            input.file_type,
            input.mime_type,
            input.file_size,
            input.duration || null,
            input.thumbnail_path || null,
            now
        ]);
        
        const mediaFile = await this.findById(id);
        if (!mediaFile) {
            throw new Error('Failed to create media file');
        }
        
        return mediaFile;
    }

    static async findById(id: string): Promise<MediaFile | null> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} WHERE id = ?`;
        const row = await this.getQuery<MediaFileRow>(sql, [id]);
        
        if (!row) {
            return null;
        }
        
        return this.convertRowToModel<MediaFile>(row, this.DATE_FIELDS);
    }

    static async findByFilename(filename: string): Promise<MediaFile | null> {
        const sql = `SELECT * FROM ${this.TABLE_NAME} WHERE filename = ?`;
        const row = await this.getQuery<MediaFileRow>(sql, [filename]);
        
        if (!row) {
            return null;
        }
        
        return this.convertRowToModel<MediaFile>(row, this.DATE_FIELDS);
    }

    static async findAll(fileType?: 'video' | 'image'): Promise<MediaFile[]> {
        let sql = `SELECT * FROM ${this.TABLE_NAME}`;
        const params: any[] = [];
        
        if (fileType) {
            sql += ' WHERE file_type = ?';
            params.push(fileType);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        const rows = await this.allQuery<MediaFileRow>(sql, params);
        return this.convertRowsToModels<MediaFile>(rows, this.DATE_FIELDS);
    }

    static async delete(id: string): Promise<boolean> {
        const sql = `DELETE FROM ${this.TABLE_NAME} WHERE id = ?`;
        
        try {
            await this.runQuery(sql, [id]);
            return true;
        } catch (error) {
            console.error('Error deleting media file:', error);
            return false;
        }
    }

    static async exists(id: string): Promise<boolean> {
        const sql = `SELECT 1 FROM ${this.TABLE_NAME} WHERE id = ? LIMIT 1`;
        const result = await this.getQuery(sql, [id]);
        return !!result;
    }

    static async existsByFilename(filename: string): Promise<boolean> {
        const sql = `SELECT 1 FROM ${this.TABLE_NAME} WHERE filename = ? LIMIT 1`;
        const result = await this.getQuery(sql, [filename]);
        return !!result;
    }

    static async updateThumbnailPath(id: string, thumbnailPath: string): Promise<boolean> {
        const sql = `UPDATE ${this.TABLE_NAME} SET thumbnail_path = ? WHERE id = ?`;
        
        try {
            await this.runQuery(sql, [thumbnailPath, id]);
            return true;
        } catch (error) {
            console.error('Error updating thumbnail path:', error);
            return false;
        }
    }

    static async getFileStats(): Promise<{ totalFiles: number; totalSize: number; videoCount: number; imageCount: number }> {
        const sql = `
            SELECT 
                COUNT(*) as totalFiles,
                SUM(file_size) as totalSize,
                SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END) as videoCount,
                SUM(CASE WHEN file_type = 'image' THEN 1 ELSE 0 END) as imageCount
            FROM ${this.TABLE_NAME}
        `;
        
        const result = await this.getQuery<{
            totalFiles: number;
            totalSize: number;
            videoCount: number;
            imageCount: number;
        }>(sql);
        
        return result || { totalFiles: 0, totalSize: 0, videoCount: 0, imageCount: 0 };
    }
}