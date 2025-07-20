/**
 * Frontend Tests for Playlist Management Components
 * Tests playlist CRUD operations, drag-and-drop, search/filter, and UI interactions
 */

// Mock API client for testing
class MockApiClient {
    constructor() {
        this.playlists = [
            {
                id: '1',
                name: 'Test Playlist 1',
                description: 'First test playlist',
                created_at: '2024-01-01T10:00:00Z',
                updated_at: '2024-01-02T10:00:00Z',
                items: [
                    {
                        id: 'item1',
                        playlist_id: '1',
                        media_file_id: 'media1',
                        order_index: 0,
                        media_file: {
                            id: 'media1',
                            original_name: 'video1.mp4',
                            file_type: 'video'
                        }
                    },
                    {
                        id: 'item2',
                        playlist_id: '1',
                        media_file_id: 'media2',
                        order_index: 1,
                        media_file: {
                            id: 'media2',
                            original_name: 'image1.jpg',
                            file_type: 'image'
                        }
                    }
                ]
            },
            {
                id: '2',
                name: 'Test Playlist 2',
                description: 'Second test playlist',
                created_at: '2024-01-03T10:00:00Z',
                updated_at: '2024-01-04T10:00:00Z',
                items: []
            }
        ];
        this.activePlaylist = null;
        this.toastMessages = [];
    }

    async getPlaylists(includeItems = false) {
        return { data: this.playlists };
    }

    async getPlaylist(id) {
        const playlist = this.playlists.find(p => p.id === id);
        if (!playlist) throw new Error('Playlist not found');
        return { data: playlist };
    }

    async createPlaylist(data) {
        const newPlaylist = {
            id: Date.now().toString(),
            ...data,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            items: []
        };
        this.playlists.push(newPlaylist);
        return { data: newPlaylist };
    }

    async updatePlaylist(id, data) {
        const playlist = this.playlists.find(p => p.id === id);
        if (!playlist) throw new Error('Playlist not found');
        Object.assign(playlist, data, { updated_at: new Date().toISOString() });
        return { data: playlist };
    }

    async deletePlaylist(id) {
        const index = this.playlists.findIndex(p => p.id === id);
        if (index === -1) throw new Error('Playlist not found');
        this.playlists.splice(index, 1);
        return { success: true };
    }

    async activatePlaylist(id) {
        this.activePlaylist = id ? this.playlists.find(p => p.id === id) : null;
        return { data: this.activePlaylist };
    }

    async deletePlaylistItem(playlistId, itemId) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) throw new Error('Playlist not found');
        const itemIndex = playlist.items.findIndex(item => item.id === itemId);
        if (itemIndex === -1) throw new Error('Item not found');
        playlist.items.splice(itemIndex, 1);
        return { success: true };
    }

    async updatePlaylistItem(playlistId, itemId, data) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) throw new Error('Playlist not found');
        const item = playlist.items.find(item => item.id === itemId);
        if (!item) throw new Error('Item not found');
        Object.assign(item, data);
        return { data: item };
    }

    showSuccessToast(message) {
        this.toastMessages.push({ type: 'success', message });
    }

    showErrorToast(message) {
        this.toastMessages.push({ type: 'error', message });
    }

    showLoading() {
        // Mock implementation
    }

    hideLoading() {
        // Mock implementation
    }
}

// Test Suite
class PlaylistManagerTests {
    constructor() {
        this.tests = [];
        this.setupCount = 0;
        this.teardownCount = 0;
    }

    /**
     * Set up test environment
     */
    setup() {
        this.setupCount++;
        
        // Create test DOM structure
        document.body.innerHTML = `
            <div id="playlist-management"></div>
            <div id="app">
                <div class="main-content">
                    <section id="playlists-section" class="content-section active">
                        <div id="playlist-management" class="content-area"></div>
                    </section>
                </div>
            </div>
        `;

        // Mock global objects
        window.apiClient = new MockApiClient();
        window.app = {
            activePlaylist: null
        };

        // Create playlist manager instance
        this.playlistManager = new PlaylistManager();
        
        // Wait for initialization
        return new Promise(resolve => setTimeout(resolve, 100));
    }

    /**
     * Clean up after tests
     */
    teardown() {
        this.teardownCount++;
        
        // Clean up DOM
        document.body.innerHTML = '';
        
        // Clean up global objects
        delete window.apiClient;
        delete window.app;
        delete window.playlistManager;
        
        this.playlistManager = null;
    }

    /**
     * Test playlist loading and rendering
     */
    async testPlaylistLoading() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const playlistCards = document.querySelectorAll('.playlist-card');
            this.assert(playlistCards.length === 2, 'Should render 2 playlist cards');
            
            const firstCard = playlistCards[0];
            const playlistName = firstCard.querySelector('.playlist-name');
            this.assert(playlistName.textContent === 'Test Playlist 1', 'Should display correct playlist name');
            
            const itemCount = firstCard.querySelector('.item-count');
            this.assert(itemCount.textContent === '2 items', 'Should display correct item count');
            
            console.log('✓ Playlist loading test passed');
            return true;
        } catch (error) {
            console.error('✗ Playlist loading test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test search functionality
     */
    async testSearchFunctionality() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const searchInput = document.getElementById('playlist-search');
            this.assert(searchInput, 'Search input should exist');
            
            // Test search
            searchInput.value = 'Test Playlist 1';
            searchInput.dispatchEvent(new Event('input'));
            
            // Wait for filter to apply
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const playlistCards = document.querySelectorAll('.playlist-card');
            this.assert(playlistCards.length === 1, 'Should filter to 1 playlist');
            
            const playlistName = playlistCards[0].querySelector('.playlist-name');
            this.assert(playlistName.textContent === 'Test Playlist 1', 'Should show correct filtered playlist');
            
            // Test empty search
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input'));
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const allCards = document.querySelectorAll('.playlist-card');
            this.assert(allCards.length === 2, 'Should show all playlists when search is cleared');
            
            console.log('✓ Search functionality test passed');
            return true;
        } catch (error) {
            console.error('✗ Search functionality test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test sorting functionality
     */
    async testSortingFunctionality() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const sortSelect = document.getElementById('playlist-sort');
            const sortOrderBtn = document.getElementById('sort-order-btn');
            
            this.assert(sortSelect, 'Sort select should exist');
            this.assert(sortOrderBtn, 'Sort order button should exist');
            
            // Test sort by date
            sortSelect.value = 'created_at';
            sortSelect.dispatchEvent(new Event('change'));
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const playlistCards = document.querySelectorAll('.playlist-card');
            const firstPlaylistName = playlistCards[0].querySelector('.playlist-name').textContent;
            this.assert(firstPlaylistName === 'Test Playlist 1', 'Should sort by creation date ascending');
            
            // Test sort order toggle
            sortOrderBtn.click();
            
            await new Promise(resolve => setTimeout(resolve, 100));
            
            const sortedCards = document.querySelectorAll('.playlist-card');
            const firstSortedName = sortedCards[0].querySelector('.playlist-name').textContent;
            this.assert(firstSortedName === 'Test Playlist 2', 'Should sort by creation date descending');
            
            console.log('✓ Sorting functionality test passed');
            return true;
        } catch (error) {
            console.error('✗ Sorting functionality test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test create playlist modal
     */
    async testCreatePlaylistModal() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Test modal opening
            this.playlistManager.showCreateModal();
            
            const modal = document.getElementById('playlist-modal');
            this.assert(!modal.classList.contains('hidden'), 'Modal should be visible');
            
            const title = document.getElementById('modal-title');
            this.assert(title.textContent === 'Create New Playlist', 'Should show create title');
            
            const nameInput = document.getElementById('playlist-name');
            const descInput = document.getElementById('playlist-description');
            
            this.assert(nameInput.value === '', 'Name input should be empty');
            this.assert(descInput.value === '', 'Description input should be empty');
            
            // Test form validation
            const form = document.getElementById('playlist-form');
            const submitEvent = new Event('submit');
            form.dispatchEvent(submitEvent);
            
            const nameError = document.getElementById('name-error');
            this.assert(nameError.textContent.includes('required'), 'Should show validation error for empty name');
            
            // Test modal closing
            const closeBtn = document.getElementById('close-modal');
            closeBtn.click();
            
            this.assert(modal.classList.contains('hidden'), 'Modal should be hidden after closing');
            
            console.log('✓ Create playlist modal test passed');
            return true;
        } catch (error) {
            console.error('✗ Create playlist modal test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test playlist creation
     */
    async testPlaylistCreation() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const initialCount = window.apiClient.playlists.length;
            
            // Open create modal
            this.playlistManager.showCreateModal();
            
            // Fill form
            const nameInput = document.getElementById('playlist-name');
            const descInput = document.getElementById('playlist-description');
            
            nameInput.value = 'New Test Playlist';
            descInput.value = 'Test description';
            
            // Submit form
            const form = document.getElementById('playlist-form');
            const submitEvent = new Event('submit');
            submitEvent.preventDefault = () => {}; // Mock preventDefault
            form.dispatchEvent(submitEvent);
            
            // Wait for creation
            await new Promise(resolve => setTimeout(resolve, 200));
            
            this.assert(window.apiClient.playlists.length === initialCount + 1, 'Should create new playlist');
            
            const newPlaylist = window.apiClient.playlists[window.apiClient.playlists.length - 1];
            this.assert(newPlaylist.name === 'New Test Playlist', 'Should have correct name');
            this.assert(newPlaylist.description === 'Test description', 'Should have correct description');
            
            console.log('✓ Playlist creation test passed');
            return true;
        } catch (error) {
            console.error('✗ Playlist creation test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test playlist editing
     */
    async testPlaylistEditing() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Test edit modal opening
            await this.playlistManager.editPlaylist('1');
            
            const modal = document.getElementById('playlist-modal');
            this.assert(!modal.classList.contains('hidden'), 'Edit modal should be visible');
            
            const title = document.getElementById('modal-title');
            this.assert(title.textContent === 'Edit Playlist', 'Should show edit title');
            
            const nameInput = document.getElementById('playlist-name');
            const descInput = document.getElementById('playlist-description');
            
            this.assert(nameInput.value === 'Test Playlist 1', 'Should populate name field');
            this.assert(descInput.value === 'First test playlist', 'Should populate description field');
            
            // Modify values
            nameInput.value = 'Updated Playlist Name';
            descInput.value = 'Updated description';
            
            // Submit form
            const form = document.getElementById('playlist-form');
            const submitEvent = new Event('submit');
            submitEvent.preventDefault = () => {}; // Mock preventDefault
            form.dispatchEvent(submitEvent);
            
            // Wait for update
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const updatedPlaylist = window.apiClient.playlists.find(p => p.id === '1');
            this.assert(updatedPlaylist.name === 'Updated Playlist Name', 'Should update playlist name');
            this.assert(updatedPlaylist.description === 'Updated description', 'Should update playlist description');
            
            console.log('✓ Playlist editing test passed');
            return true;
        } catch (error) {
            console.error('✗ Playlist editing test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test delete confirmation modal
     */
    async testDeleteConfirmation() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            // Test delete modal opening
            this.playlistManager.showDeleteModal('1');
            
            const deleteModal = document.getElementById('delete-modal');
            this.assert(!deleteModal.classList.contains('hidden'), 'Delete modal should be visible');
            
            const playlistName = document.getElementById('delete-playlist-name');
            this.assert(playlistName.textContent === 'Test Playlist 1', 'Should show correct playlist name');
            
            // Test cancel
            const cancelBtn = document.getElementById('cancel-delete');
            cancelBtn.click();
            
            this.assert(deleteModal.classList.contains('hidden'), 'Modal should be hidden after cancel');
            this.assert(window.apiClient.playlists.length === 2, 'Should not delete playlist on cancel');
            
            console.log('✓ Delete confirmation test passed');
            return true;
        } catch (error) {
            console.error('✗ Delete confirmation test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test playlist deletion
     */
    async testPlaylistDeletion() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const initialCount = window.apiClient.playlists.length;
            
            // Open delete modal and confirm
            this.playlistManager.showDeleteModal('2');
            
            const confirmBtn = document.getElementById('confirm-delete');
            confirmBtn.click();
            
            // Wait for deletion
            await new Promise(resolve => setTimeout(resolve, 200));
            
            this.assert(window.apiClient.playlists.length === initialCount - 1, 'Should delete playlist');
            
            const deletedPlaylist = window.apiClient.playlists.find(p => p.id === '2');
            this.assert(!deletedPlaylist, 'Deleted playlist should not exist');
            
            console.log('✓ Playlist deletion test passed');
            return true;
        } catch (error) {
            console.error('✗ Playlist deletion test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test drag and drop setup
     */
    async testDragAndDropSetup() {
        await this.setup();
        
        try {
            // Wait for playlists to load
            await new Promise(resolve => setTimeout(resolve, 200));
            
            const playlistItems = document.querySelectorAll('.playlist-item');
            this.assert(playlistItems.length > 0, 'Should have playlist items');
            
            const firstItem = playlistItems[0];
            this.assert(firstItem.draggable === true, 'Playlist items should be draggable');
            
            const dragHandle = firstItem.querySelector('.drag-handle');
            this.assert(dragHandle, 'Should have drag handle');
            
            console.log('✓ Drag and drop setup test passed');
            return true;
        } catch (error) {
            console.error('✗ Drag and drop setup test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Test utility functions
     */
    async testUtilityFunctions() {
        await this.setup();
        
        try {
            // Test HTML escaping
            const escaped = this.playlistManager.escapeHtml('<script>alert("xss")</script>');
            this.assert(escaped === '&lt;script&gt;alert("xss")&lt;/script&gt;', 'Should escape HTML properly');
            
            // Test date formatting
            const today = new Date();
            const todayFormatted = this.playlistManager.formatDate(today.toISOString());
            this.assert(todayFormatted === 'Today', 'Should format today correctly');
            
            const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
            const yesterdayFormatted = this.playlistManager.formatDate(yesterday.toISOString());
            this.assert(yesterdayFormatted === 'Yesterday', 'Should format yesterday correctly');
            
            console.log('✓ Utility functions test passed');
            return true;
        } catch (error) {
            console.error('✗ Utility functions test failed:', error);
            return false;
        } finally {
            this.teardown();
        }
    }

    /**
     * Assert helper
     */
    assert(condition, message) {
        if (!condition) {
            throw new Error(`Assertion failed: ${message}`);
        }
    }

    /**
     * Run all tests
     */
    async runAllTests() {
        console.log('🧪 Running Playlist Manager Tests...\n');
        
        const tests = [
            { name: 'Playlist Loading', fn: this.testPlaylistLoading },
            { name: 'Search Functionality', fn: this.testSearchFunctionality },
            { name: 'Sorting Functionality', fn: this.testSortingFunctionality },
            { name: 'Create Playlist Modal', fn: this.testCreatePlaylistModal },
            { name: 'Playlist Creation', fn: this.testPlaylistCreation },
            { name: 'Playlist Editing', fn: this.testPlaylistEditing },
            { name: 'Delete Confirmation', fn: this.testDeleteConfirmation },
            { name: 'Playlist Deletion', fn: this.testPlaylistDeletion },
            { name: 'Drag and Drop Setup', fn: this.testDragAndDropSetup },
            { name: 'Utility Functions', fn: this.testUtilityFunctions }
        ];
        
        let passed = 0;
        let failed = 0;
        
        for (const test of tests) {
            try {
                const result = await test.fn.call(this);
                if (result) {
                    passed++;
                } else {
                    failed++;
                }
            } catch (error) {
                console.error(`Test "${test.name}" threw an error:`, error);
                failed++;
            }
        }
        
        console.log(`\n📊 Test Results:`);
        console.log(`✓ Passed: ${passed}`);
        console.log(`✗ Failed: ${failed}`);
        console.log(`📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);
        
        if (failed === 0) {
            console.log('\n🎉 All tests passed!');
        } else {
            console.log(`\n⚠️  ${failed} test(s) failed. Please review the output above.`);
        }
        
        return { passed, failed, total: passed + failed };
    }
}

// Export for use in browser or Node.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlaylistManagerTests;
} else {
    window.PlaylistManagerTests = PlaylistManagerTests;
}

// Auto-run tests if this file is loaded directly in browser
if (typeof window !== 'undefined' && window.location) {
    // Only run if this is the main script being executed
    if (document.currentScript && document.currentScript.src.includes('playlist-manager.test.js')) {
        document.addEventListener('DOMContentLoaded', async () => {
            const testRunner = new PlaylistManagerTests();
            await testRunner.runAllTests();
        });
    }
}