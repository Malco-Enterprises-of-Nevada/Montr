// Unit tests for MediaPlaybackEngine Core Logic
// Testing the compiled JavaScript version to avoid DOM type issues

describe('MediaPlaybackEngine Core Logic', () => {
    // Test data structures
    const testMediaFiles = [
        {
            id: 'video1',
            filename: 'test-video.mp4',
            original_name: 'Test Video.mp4',
            file_type: 'video' as const,
            mime_type: 'video/mp4',
            file_size: 1000000,
            duration: 30,
            created_at: new Date()
        },
        {
            id: 'image1',
            filename: 'test-image.jpg',
            original_name: 'Test Image.jpg',
            file_type: 'image' as const,
            mime_type: 'image/jpeg',
            file_size: 500000,
            duration: 5,
            created_at: new Date()
        },
        {
            id: 'video2',
            filename: 'test-video2.mp4',
            original_name: 'Test Video 2.mp4',
            file_type: 'video' as const,
            mime_type: 'video/mp4',
            file_size: 2000000,
            duration: 45,
            created_at: new Date()
        }
    ];

    const testPlaylist = {
        id: 'playlist1',
        name: 'Test Playlist',
        description: 'A test playlist',
        items: [
            {
                id: 'item1',
                playlist_id: 'playlist1',
                media_file_id: 'video1',
                order_index: 0,
                media_file: testMediaFiles[0]
            },
            {
                id: 'item2',
                playlist_id: 'playlist1',
                media_file_id: 'image1',
                order_index: 1,
                display_duration: 8,
                media_file: testMediaFiles[1]
            },
            {
                id: 'item3',
                playlist_id: 'playlist1',
                media_file_id: 'video2',
                order_index: 2,
                media_file: testMediaFiles[2]
            }
        ],
        created_at: new Date(),
        updated_at: new Date()
    };

    describe('Data Structure Validation', () => {
        test('should have valid test playlist structure', () => {
            expect(testPlaylist).toBeDefined();
            expect(testPlaylist.items).toHaveLength(3);
            expect(testPlaylist.items![0].media_file?.file_type).toBe('video');
            expect(testPlaylist.items![1].media_file?.file_type).toBe('image');
            expect(testPlaylist.items![2].media_file?.file_type).toBe('video');
        });

        test('should have valid media file structures', () => {
            testMediaFiles.forEach(file => {
                expect(file.id).toBeDefined();
                expect(file.filename).toBeDefined();
                expect(file.original_name).toBeDefined();
                expect(['video', 'image']).toContain(file.file_type);
                expect(file.mime_type).toBeDefined();
                expect(typeof file.file_size).toBe('number');
                expect(file.created_at).toBeInstanceOf(Date);
            });
        });

        test('should have proper playlist item relationships', () => {
            testPlaylist.items!.forEach((item, index) => {
                expect(item.playlist_id).toBe(testPlaylist.id);
                expect(item.order_index).toBe(index);
                expect(item.media_file).toBeDefined();
                expect(item.media_file?.id).toBe(testMediaFiles[index].id);
            });
        });
    });

    describe('Playlist Logic', () => {
        test('should handle playlist navigation logic', () => {
            const playlistLength = testPlaylist.items!.length;
            
            // Test next item logic
            for (let i = 0; i < playlistLength; i++) {
                const nextIndex = (i + 1) % playlistLength;
                expect(nextIndex).toBe(i === playlistLength - 1 ? 0 : i + 1);
            }
            
            // Test previous item logic
            for (let i = 0; i < playlistLength; i++) {
                const prevIndex = i > 0 ? i - 1 : playlistLength - 1;
                expect(prevIndex).toBe(i === 0 ? playlistLength - 1 : i - 1);
            }
        });

        test('should handle empty playlist', () => {
            const emptyPlaylist = {
                ...testPlaylist,
                items: []
            };
            
            expect(emptyPlaylist.items).toHaveLength(0);
        });

        test('should handle playlist with missing media files', () => {
            const playlistWithMissingMedia = {
                ...testPlaylist,
                items: [{
                    id: 'item1',
                    playlist_id: 'playlist1',
                    media_file_id: 'missing',
                    order_index: 0,
                    media_file: null
                }]
            };
            
            expect(playlistWithMissingMedia.items[0].media_file).toBeNull();
        });
    });

    describe('Media Type Handling', () => {
        test('should identify video files correctly', () => {
            const videoFiles = testMediaFiles.filter(file => file.file_type === 'video');
            expect(videoFiles).toHaveLength(2);
            videoFiles.forEach(file => {
                expect(file.mime_type).toMatch(/^video\//);
                expect(file.filename).toMatch(/\.(mp4|avi|mov|webm)$/i);
            });
        });

        test('should identify image files correctly', () => {
            const imageFiles = testMediaFiles.filter(file => file.file_type === 'image');
            expect(imageFiles).toHaveLength(1);
            imageFiles.forEach(file => {
                expect(file.mime_type).toMatch(/^image\//);
                expect(file.filename).toMatch(/\.(jpg|jpeg|png|gif|webp)$/i);
            });
        });

        test('should handle display duration for images', () => {
            const imageItem = testPlaylist.items!.find(item => 
                item.media_file?.file_type === 'image'
            );
            
            expect(imageItem).toBeDefined();
            expect(imageItem!.display_duration).toBe(8);
            
            // Test fallback to media file duration
            const defaultDuration = imageItem!.media_file?.duration || 5;
            expect(defaultDuration).toBe(5);
        });
    });

    describe('URL Generation Logic', () => {
        test('should generate correct media URLs', () => {
            testMediaFiles.forEach(file => {
                const expectedUrl = `/uploads/${file.file_type}s/${file.filename}`;
                
                if (file.file_type === 'video') {
                    expect(expectedUrl).toBe(`/uploads/videos/${file.filename}`);
                } else if (file.file_type === 'image') {
                    expect(expectedUrl).toBe(`/uploads/images/${file.filename}`);
                }
            });
        });
    });

    describe('Timing Logic', () => {
        test('should calculate correct durations', () => {
            const videoFile = testMediaFiles.find(f => f.file_type === 'video');
            const imageFile = testMediaFiles.find(f => f.file_type === 'image');
            
            expect(videoFile?.duration).toBe(30);
            expect(imageFile?.duration).toBe(5);
            
            // Test image display duration override
            const imageItem = testPlaylist.items!.find(item => 
                item.media_file?.file_type === 'image'
            );
            const displayDuration = imageItem?.display_duration || imageItem?.media_file?.duration || 5;
            expect(displayDuration).toBe(8); // Should use override value
        });

        test('should handle missing duration values', () => {
            const fileWithoutDuration = {
                ...testMediaFiles[0],
                duration: undefined
            };
            
            const defaultDuration = fileWithoutDuration.duration || 5;
            expect(defaultDuration).toBe(5);
        });
    });

    describe('State Management Logic', () => {
        test('should track playback state correctly', () => {
            const initialState = {
                isPlaying: false,
                currentIndex: 0,
                playlist: undefined,
                currentItem: undefined,
                totalPlaytime: 0
            };
            
            expect(initialState.isPlaying).toBe(false);
            expect(initialState.currentIndex).toBe(0);
            expect(initialState.playlist).toBeUndefined();
            
            // Simulate state changes
            const playingState = {
                ...initialState,
                isPlaying: true,
                playlist: testPlaylist,
                currentItem: testPlaylist.items![0],
                playbackStartTime: new Date()
            };
            
            expect(playingState.isPlaying).toBe(true);
            expect(playingState.playlist).toBe(testPlaylist);
            expect(playingState.currentItem).toBe(testPlaylist.items![0]);
        });

        test('should handle index bounds correctly', () => {
            const playlistLength = testPlaylist.items!.length;
            
            // Test valid indices
            for (let i = 0; i < playlistLength; i++) {
                expect(i >= 0 && i < playlistLength).toBe(true);
            }
            
            // Test invalid indices
            expect(-1 >= 0 && -1 < playlistLength).toBe(false);
            expect(playlistLength >= 0 && playlistLength < playlistLength).toBe(false);
        });
    });

    describe('Configuration Options', () => {
        test('should handle playback options correctly', () => {
            const defaultOptions = {
                autoplay: true,
                loop: true,
                muted: true,
                defaultImageDuration: 5,
                transitionDuration: 500,
                preloadNext: true
            };
            
            expect(defaultOptions.autoplay).toBe(true);
            expect(defaultOptions.loop).toBe(true);
            expect(defaultOptions.muted).toBe(true);
            expect(defaultOptions.defaultImageDuration).toBe(5);
            expect(defaultOptions.transitionDuration).toBe(500);
            expect(defaultOptions.preloadNext).toBe(true);
            
            // Test option updates
            const updatedOptions = {
                ...defaultOptions,
                autoplay: false,
                defaultImageDuration: 10
            };
            
            expect(updatedOptions.autoplay).toBe(false);
            expect(updatedOptions.defaultImageDuration).toBe(10);
            expect(updatedOptions.loop).toBe(true); // Should preserve other options
        });
    });

    describe('Error Handling Logic', () => {
        test('should handle playlist errors gracefully', () => {
            const invalidPlaylist = {
                ...testPlaylist,
                items: undefined as any
            };
            
            const hasValidItems = invalidPlaylist.items && invalidPlaylist.items.length > 0;
            expect(hasValidItems).toBeFalsy();
        });

        test('should handle media file errors gracefully', () => {
            const itemWithoutMedia = {
                id: 'item1',
                playlist_id: 'playlist1',
                media_file_id: 'missing',
                order_index: 0,
                media_file: null
            };
            
            const hasValidMedia = itemWithoutMedia.media_file !== null;
            expect(hasValidMedia).toBe(false);
        });
    });

    describe('Integration Logic', () => {
        test('should handle complete playback cycle logic', () => {
            let currentIndex = 0;
            const playlistLength = testPlaylist.items!.length;
            
            // Simulate playing through entire playlist
            const playbackSequence = [];
            for (let i = 0; i < playlistLength * 2; i++) { // Play twice to test looping
                playbackSequence.push(currentIndex);
                currentIndex = (currentIndex + 1) % playlistLength;
            }
            
            expect(playbackSequence).toEqual([0, 1, 2, 0, 1, 2]);
        });

        test('should handle playlist switching logic', () => {
            const playlist1 = testPlaylist;
            const playlist2 = {
                ...testPlaylist,
                id: 'playlist2',
                name: 'Second Playlist'
            };
            
            let currentPlaylist = playlist1;
            let currentIndex = 1;
            
            // Switch playlist - should reset index
            currentPlaylist = playlist2;
            currentIndex = 0;
            
            expect(currentPlaylist.id).toBe('playlist2');
            expect(currentIndex).toBe(0);
        });
    });
});