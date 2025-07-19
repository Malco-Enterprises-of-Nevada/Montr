import { dbConnection } from './connection';
import fs from 'fs';
import path from 'path';

export interface Migration {
    version: string;
    description: string;
    up: string;
    down: string;
}

export class MigrationManager {
    private static readonly MIGRATIONS_TABLE = 'migrations';

    static async initialize(): Promise<void> {
        await dbConnection.connect();
        
        // Create migrations table if it doesn't exist
        const sql = `
            CREATE TABLE IF NOT EXISTS ${this.MIGRATIONS_TABLE} (
                version TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;
        
        await dbConnection.runQuery(sql);
    }

    static async getAppliedMigrations(): Promise<string[]> {
        const sql = `SELECT version FROM ${this.MIGRATIONS_TABLE} ORDER BY version`;
        const rows = await dbConnection.allQuery<{ version: string }>(sql);
        return rows.map(row => row.version);
    }

    static async applyMigration(migration: Migration): Promise<void> {
        try {
            // Execute the migration
            const statements = migration.up
                .split(';')
                .map(stmt => stmt.trim())
                .filter(stmt => stmt.length > 0);
            
            for (const statement of statements) {
                await dbConnection.runQuery(statement);
            }
            
            // Record the migration as applied
            const sql = `
                INSERT INTO ${this.MIGRATIONS_TABLE} (version, description)
                VALUES (?, ?)
            `;
            
            await dbConnection.runQuery(sql, [migration.version, migration.description]);
            
            console.log(`Applied migration: ${migration.version} - ${migration.description}`);
        } catch (error) {
            console.error(`Failed to apply migration ${migration.version}:`, error);
            throw error;
        }
    }

    static async rollbackMigration(migration: Migration): Promise<void> {
        try {
            // Execute the rollback
            const statements = migration.down
                .split(';')
                .map(stmt => stmt.trim())
                .filter(stmt => stmt.length > 0);
            
            for (const statement of statements) {
                await dbConnection.runQuery(statement);
            }
            
            // Remove the migration record
            const sql = `DELETE FROM ${this.MIGRATIONS_TABLE} WHERE version = ?`;
            await dbConnection.runQuery(sql, [migration.version]);
            
            console.log(`Rolled back migration: ${migration.version} - ${migration.description}`);
        } catch (error) {
            console.error(`Failed to rollback migration ${migration.version}:`, error);
            throw error;
        }
    }

    static async runMigrations(migrationsDir: string): Promise<void> {
        await this.initialize();
        
        const appliedMigrations = await this.getAppliedMigrations();
        const migrationFiles = fs.readdirSync(migrationsDir)
            .filter(file => file.endsWith('.json'))
            .sort();
        
        for (const file of migrationFiles) {
            const migrationPath = path.join(migrationsDir, file);
            const migration: Migration = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
            
            if (!appliedMigrations.includes(migration.version)) {
                await this.applyMigration(migration);
            }
        }
    }

    static async createMigration(version: string, description: string, up: string, down: string): Promise<string> {
        const migration: Migration = {
            version,
            description,
            up,
            down
        };
        
        const migrationsDir = path.join(process.cwd(), 'migrations');
        if (!fs.existsSync(migrationsDir)) {
            fs.mkdirSync(migrationsDir, { recursive: true });
        }
        
        const filename = `${version}_${description.replace(/\s+/g, '_').toLowerCase()}.json`;
        const filepath = path.join(migrationsDir, filename);
        
        fs.writeFileSync(filepath, JSON.stringify(migration, null, 2));
        
        return filepath;
    }
}