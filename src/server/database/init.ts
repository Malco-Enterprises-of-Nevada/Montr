import { dbConnection } from './connection';
import fs from 'fs';
import path from 'path';

export async function initializeDatabase(customPath?: string): Promise<void> {
    try {
        // Connect to database
        await dbConnection.connect(customPath);
        
        // Read and execute schema
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        
        // Remove comments and split by semicolons, but handle multi-line statements
        const cleanedSchema = schema
            .replace(/--.*$/gm, '') // Remove line comments
            .replace(/\/\*[\s\S]*?\*\//g, ''); // Remove block comments
        
        // Split by semicolons but be careful with triggers and multi-line statements
        const statements: string[] = [];
        let currentStatement = '';
        let inTrigger = false;
        
        const lines = cleanedSchema.split('\n');
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.length === 0) continue;
            
            currentStatement += line + '\n';
            
            if (trimmedLine.toUpperCase().includes('CREATE TRIGGER')) {
                inTrigger = true;
            }
            
            if (trimmedLine.endsWith(';')) {
                if (inTrigger && trimmedLine.toUpperCase().includes('END')) {
                    inTrigger = false;
                    statements.push(currentStatement.trim());
                    currentStatement = '';
                } else if (!inTrigger) {
                    statements.push(currentStatement.trim());
                    currentStatement = '';
                }
            }
        }
        
        // Add any remaining statement
        if (currentStatement.trim().length > 0) {
            statements.push(currentStatement.trim());
        }
        
        for (const statement of statements) {
            if (statement.length > 0) {
                await dbConnection.runQuery(statement);
            }
        }
        
        console.log('Database initialized successfully');
    } catch (error) {
        console.error('Failed to initialize database:', error);
        throw error;
    }
}

export async function resetDatabase(): Promise<void> {
    try {
        await dbConnection.connect();
        
        // Drop all tables
        const dropStatements = [
            'DROP TABLE IF EXISTS playlist_items',
            'DROP TABLE IF EXISTS media_files',
            'DROP TABLE IF EXISTS playlists',
            'DROP TABLE IF EXISTS system_state'
        ];
        
        for (const statement of dropStatements) {
            await dbConnection.runQuery(statement);
        }
        
        console.log('Database reset completed');
        
        // Reinitialize
        await initializeDatabase();
    } catch (error) {
        console.error('Failed to reset database:', error);
        throw error;
    }
}