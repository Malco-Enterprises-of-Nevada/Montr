import sqlite3 from 'sqlite3';
import { Database } from 'sqlite3';
import path from 'path';
import fs from 'fs';

export class DatabaseConnection {
    private static instance: DatabaseConnection;
    private db: Database | null = null;
    private dbPath: string;

    private constructor() {
        // Create database directory if it doesn't exist
        const dbDir = path.join(process.cwd(), 'data');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        
        this.dbPath = path.join(dbDir, 'media_playlist.db');
    }

    public static getInstance(): DatabaseConnection {
        if (!DatabaseConnection.instance) {
            DatabaseConnection.instance = new DatabaseConnection();
        }
        return DatabaseConnection.instance;
    }

    public async connect(customPath?: string): Promise<Database> {
        if (this.db) {
            return this.db;
        }

        const dbPath = customPath || this.dbPath;

        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(dbPath, (err) => {
                if (err) {
                    console.error('Error opening database:', err.message);
                    reject(err);
                } else {
                    console.log('Connected to SQLite database at:', dbPath);
                    // Enable foreign key constraints
                    this.db!.run('PRAGMA foreign_keys = ON');
                    resolve(this.db!);
                }
            });
        });
    }

    public setDatabasePath(path: string): void {
        this.dbPath = path;
    }

    public getDatabase(): Database {
        if (!this.db) {
            throw new Error('Database not connected. Call connect() first.');
        }
        return this.db;
    }

    public async close(): Promise<void> {
        if (!this.db) {
            return;
        }

        return new Promise((resolve, reject) => {
            this.db!.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                    reject(err);
                } else {
                    console.log('Database connection closed.');
                    this.db = null;
                    resolve();
                }
            });
        });
    }

    public async runQuery(sql: string, params: any[] = []): Promise<void> {
        const db = this.getDatabase();
        return new Promise((resolve, reject) => {
            db.run(sql, params, function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    public async getQuery<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
        const db = this.getDatabase();
        return new Promise((resolve, reject) => {
            db.get(sql, params, (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row as T);
                }
            });
        });
    }

    public async allQuery<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        const db = this.getDatabase();
        return new Promise((resolve, reject) => {
            db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows as T[]);
                }
            });
        });
    }
}

export const dbConnection = DatabaseConnection.getInstance();