import { PlaylistModel } from '../models/PlaylistModel';
import { MediaFileModel } from '../models/MediaFileModel';
import { PlaylistItemModel } from '../models/PlaylistItemModel';
import { SystemStateModel } from '../models/SystemStateModel';
import { dbConnection } from './connection';

export class DatabaseSeeder {
    static async seedSampleData(): Promise<void> {
        try {
            await dbConnection.connect();
            
            console.log('Starting database seeding...');
            
            // Create sample media files
            const sampleVideo = await MediaFileModel.create({
                filename: 'sample_video.mp4',
                original_name: 'Sample Video.mp4',
                file_type: 'video',
                mime_type: 'video/mp4',
                file_size: 1024000, // 1MB
                duration: 30 // 30 seconds
            });
            
            const sampleImage1 = await MediaFileModel.create({
                filename: 'sample_image1.jpg',
                original_name: 'Sample Image 1.jpg',
                file_type: 'image',
                mime_type: 'image/jpeg',
                file_size: 512000, // 512KB
                duration: 5 // 5 seconds display time
            });
            
            const sampleImage2 = await MediaFileModel.create({
                filename: 'sample_image2.png',
                original_name: 'Sample Image 2.png',
                file_type: 'image',
                mime_type: 'image/png',
                file_size: 768000, // 768KB
                duration: 8 // 8 seconds display time
            });
            
            // Create sample playlists
            const playlist1 = await PlaylistModel.create({
                name: 'Welcome Playlist',
                description: 'A sample playlist with mixed media content'
            });
            
            const playlist2 = await PlaylistModel.create({
                name: 'Image Gallery',
                description: 'A playlist containing only images'
            });
            
            // Add items to first playlist
            await PlaylistItemModel.create({
                playlist_id: playlist1.id,
                media_file_id: sampleVideo.id,
                order_index: 1
            });
            
            await PlaylistItemModel.create({
                playlist_id: playlist1.id,
                media_file_id: sampleImage1.id,
                order_index: 2,
                display_duration: 10 // Override to 10 seconds
            });
            
            await PlaylistItemModel.create({
                playlist_id: playlist1.id,
                media_file_id: sampleImage2.id,
                order_index: 3
            });
            
            // Add items to second playlist (images only)
            await PlaylistItemModel.create({
                playlist_id: playlist2.id,
                media_file_id: sampleImage1.id,
                order_index: 1
            });
            
            await PlaylistItemModel.create({
                playlist_id: playlist2.id,
                media_file_id: sampleImage2.id,
                order_index: 2
            });
            
            // Set the first playlist as active
            await SystemStateModel.setActivePlaylistId(playlist1.id);
            
            console.log('Database seeding completed successfully!');
            console.log(`Created ${2} playlists and ${3} media files`);
            
        } catch (error) {
            console.error('Error seeding database:', error);
            throw error;
        }
    }
    
    static async clearAllData(): Promise<void> {
        try {
            await dbConnection.connect();
            
            console.log('Clearing all data...');
            
            // Clear in reverse order of dependencies
            await dbConnection.runQuery('DELETE FROM playlist_items');
            await dbConnection.runQuery('DELETE FROM media_files');
            await dbConnection.runQuery('DELETE FROM playlists');
            await dbConnection.runQuery('DELETE FROM system_state WHERE key != "active_playlist_id"');
            await SystemStateModel.clearActivePlaylist();
            
            console.log('All data cleared successfully!');
            
        } catch (error) {
            console.error('Error clearing data:', error);
            throw error;
        }
    }
    
    static async resetAndSeed(): Promise<void> {
        await this.clearAllData();
        await this.seedSampleData();
    }
}