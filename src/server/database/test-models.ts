#!/usr/bin/env node

import { initializeDatabase } from './init';
import { PlaylistModel, MediaFileModel, PlaylistItemModel, SystemStateModel } from '../models';
import { dbConnection } from './connection';

async function testModels() {
    try {
        await initializeDatabase();
        
        console.log('Testing database models...\n');
        
        // Test MediaFile model
        console.log('1. Testing MediaFile model:');
        const mediaFile = await MediaFileModel.create({
            filename: 'test_video.mp4',
            original_name: 'Test Video.mp4',
            file_type: 'video',
            mime_type: 'video/mp4',
            file_size: 2048000,
            duration: 60
        });
        console.log('✓ Created media file:', mediaFile.id);
        
        const foundMediaFile = await MediaFileModel.findById(mediaFile.id);
        console.log('✓ Found media file by ID:', foundMediaFile?.original_name);
        
        // Test Playlist model
        console.log('\n2. Testing Playlist model:');
        const playlist = await PlaylistModel.create({
            name: 'Test Playlist',
            description: 'A test playlist'
        });
        console.log('✓ Created playlist:', playlist.id);
        
        const foundPlaylist = await PlaylistModel.findById(playlist.id);
        console.log('✓ Found playlist by ID:', foundPlaylist?.name);
        
        // Test PlaylistItem model
        console.log('\n3. Testing PlaylistItem model:');
        const playlistItem = await PlaylistItemModel.create({
            playlist_id: playlist.id,
            media_file_id: mediaFile.id,
            order_index: 1
        });
        console.log('✓ Created playlist item:', playlistItem.id);
        
        const playlistItems = await PlaylistItemModel.findByPlaylistId(playlist.id);
        console.log('✓ Found playlist items:', playlistItems.length);
        console.log('✓ Media file attached:', playlistItems[0]?.media_file?.original_name);
        
        // Test SystemState model
        console.log('\n4. Testing SystemState model:');
        await SystemStateModel.setActivePlaylistId(playlist.id);
        const activePlaylistId = await SystemStateModel.getActivePlaylistId();
        console.log('✓ Set and retrieved active playlist ID:', activePlaylistId);
        
        // Test playlist with items
        console.log('\n5. Testing playlist with items:');
        const playlistWithItems = await PlaylistModel.findById(playlist.id, true);
        console.log('✓ Playlist with items loaded:', playlistWithItems?.items?.length);
        
        // Test search functionality
        console.log('\n6. Testing search functionality:');
        const searchResults = await PlaylistModel.search('Test');
        console.log('✓ Search results:', searchResults.length);
        
        // Test file stats
        console.log('\n7. Testing file stats:');
        const stats = await MediaFileModel.getFileStats();
        console.log('✓ File stats:', stats);
        
        console.log('\n✅ All model tests passed!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
        throw error;
    } finally {
        await dbConnection.close();
    }
}

if (require.main === module) {
    testModels().catch(console.error);
}