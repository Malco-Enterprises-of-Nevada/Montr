import { initializeDatabase, resetDatabase } from '../init';
import { PlaylistModel, MediaFileModel, PlaylistItemModel, SystemStateModel } from '../../models';
import { dbConnection } from '../connection';

describe('Database Models', () => {
    beforeAll(async () => {
        await resetDatabase();
    });

    afterAll(async () => {
        await dbConnection.close();
    });

    describe('MediaFileModel', () => {
        test('should create and retrieve a media file', async () => {
            const mediaFile = await MediaFileModel.create({
                filename: 'test.mp4',
                original_name: 'Test Video.mp4',
                file_type: 'video',
                mime_type: 'video/mp4',
                file_size: 1024000,
                duration: 30
            });

            expect(mediaFile.id).toBeDefined();
            expect(mediaFile.original_name).toBe('Test Video.mp4');
            expect(mediaFile.file_type).toBe('video');

            const found = await MediaFileModel.findById(mediaFile.id);
            expect(found).toBeTruthy();
            expect(found?.original_name).toBe('Test Video.mp4');
        });

        test('should check if media file exists', async () => {
            const mediaFile = await MediaFileModel.create({
                filename: 'test2.jpg',
                original_name: 'Test Image.jpg',
                file_type: 'image',
                mime_type: 'image/jpeg',
                file_size: 512000,
                duration: 5
            });

            const exists = await MediaFileModel.exists(mediaFile.id);
            expect(exists).toBe(true);

            const notExists = await MediaFileModel.exists('non-existent-id');
            expect(notExists).toBe(false);
        });
    });

    describe('PlaylistModel', () => {
        test('should create and retrieve a playlist', async () => {
            const playlist = await PlaylistModel.create({
                name: 'Test Playlist',
                description: 'A test playlist'
            });

            expect(playlist.id).toBeDefined();
            expect(playlist.name).toBe('Test Playlist');
            expect(playlist.description).toBe('A test playlist');

            const found = await PlaylistModel.findById(playlist.id);
            expect(found).toBeTruthy();
            expect(found?.name).toBe('Test Playlist');
        });

        test('should update a playlist', async () => {
            const playlist = await PlaylistModel.create({
                name: 'Original Name',
                description: 'Original description'
            });

            const updated = await PlaylistModel.update(playlist.id, {
                name: 'Updated Name',
                description: 'Updated description'
            });

            expect(updated?.name).toBe('Updated Name');
            expect(updated?.description).toBe('Updated description');
        });

        test('should search playlists', async () => {
            await PlaylistModel.create({
                name: 'Searchable Playlist',
                description: 'This is searchable'
            });

            const results = await PlaylistModel.search('Searchable');
            expect(results.length).toBeGreaterThan(0);
            expect(results[0].name).toContain('Searchable');
        });
    });

    describe('PlaylistItemModel', () => {
        test('should create playlist items and maintain order', async () => {
            const mediaFile = await MediaFileModel.create({
                filename: 'item-test.mp4',
                original_name: 'Item Test.mp4',
                file_type: 'video',
                mime_type: 'video/mp4',
                file_size: 1024000,
                duration: 30
            });

            const playlist = await PlaylistModel.create({
                name: 'Item Test Playlist'
            });

            const item1 = await PlaylistItemModel.create({
                playlist_id: playlist.id,
                media_file_id: mediaFile.id,
                order_index: 1
            });

            const item2 = await PlaylistItemModel.create({
                playlist_id: playlist.id,
                media_file_id: mediaFile.id,
                order_index: 2
            });

            const items = await PlaylistItemModel.findByPlaylistId(playlist.id);
            expect(items).toHaveLength(2);
            expect(items[0].order_index).toBe(1);
            expect(items[1].order_index).toBe(2);
            expect(items[0].media_file?.original_name).toBe('Item Test.mp4');
        });
    });

    describe('SystemStateModel', () => {
        test('should set and get system state', async () => {
            await SystemStateModel.set('test_key', 'test_value');
            const value = await SystemStateModel.get('test_key');
            expect(value).toBe('test_value');
        });

        test('should handle active playlist ID', async () => {
            const playlist = await PlaylistModel.create({
                name: 'Active Test Playlist'
            });

            await SystemStateModel.setActivePlaylistId(playlist.id);
            const activeId = await SystemStateModel.getActivePlaylistId();
            expect(activeId).toBe(playlist.id);

            await SystemStateModel.clearActivePlaylist();
            const clearedId = await SystemStateModel.getActivePlaylistId();
            expect(clearedId).toBeNull();
        });
    });
});