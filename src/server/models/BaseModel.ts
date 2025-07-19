import { dbConnection } from '../database/connection';
import { v4 as uuidv4 } from 'uuid';

export abstract class BaseModel {
    protected static generateId(): string {
        return uuidv4();
    }

    protected static async runQuery(sql: string, params: any[] = []): Promise<void> {
        return dbConnection.runQuery(sql, params);
    }

    protected static async getQuery<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
        return dbConnection.getQuery<T>(sql, params);
    }

    protected static async allQuery<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        return dbConnection.allQuery<T>(sql, params);
    }

    protected static convertRowToModel<T>(row: any, dateFields: string[] = []): T {
        if (!row) return row;
        
        const converted = { ...row };
        
        // Convert date strings to Date objects
        dateFields.forEach(field => {
            if (converted[field]) {
                converted[field] = new Date(converted[field]);
            }
        });
        
        return converted as T;
    }

    protected static convertRowsToModels<T>(rows: any[], dateFields: string[] = []): T[] {
        return rows.map(row => this.convertRowToModel<T>(row, dateFields));
    }
}