#!/usr/bin/env node

import { initializeDatabase, resetDatabase } from './init';
import { DatabaseSeeder } from './seeder';
import { dbConnection } from './connection';

async function main() {
    const command = process.argv[2];
    
    try {
        switch (command) {
            case 'init':
                console.log('Initializing database...');
                await initializeDatabase();
                console.log('Database initialized successfully!');
                break;
                
            case 'reset':
                console.log('Resetting database...');
                await resetDatabase();
                console.log('Database reset successfully!');
                break;
                
            case 'seed':
                console.log('Seeding database...');
                await initializeDatabase();
                await DatabaseSeeder.seedSampleData();
                console.log('Database seeded successfully!');
                break;
                
            case 'clear':
                console.log('Clearing database data...');
                await DatabaseSeeder.clearAllData();
                console.log('Database cleared successfully!');
                break;
                
            case 'reset-and-seed':
                console.log('Resetting and seeding database...');
                await resetDatabase();
                await DatabaseSeeder.seedSampleData();
                console.log('Database reset and seeded successfully!');
                break;
                
            default:
                console.log('Available commands:');
                console.log('  init           - Initialize database schema');
                console.log('  reset          - Reset database (drop and recreate tables)');
                console.log('  seed           - Seed database with sample data');
                console.log('  clear          - Clear all data from database');
                console.log('  reset-and-seed - Reset database and seed with sample data');
                break;
        }
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    } finally {
        await dbConnection.close();
        process.exit(0);
    }
}

if (require.main === module) {
    main();
}