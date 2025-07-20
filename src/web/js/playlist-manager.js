/**
 * Playlist Management Component
 * Handles playlist CRUD operations, drag-and-drop reordering, and UI interactions
 */
class PlaylistManager {
    constructor() {
        this.playlists = [];
        this.filteredPlaylists = [];
        this.searchTerm = '';
        this.sortBy = 'name';
        this.sortOrder = 'asc';
        this.selectedPlaylist = null;
        this.draggedItem = null;
        
        this.initializeComponent();
    }

    /**
     * Initialize the playlist management component
     */
    initializeComponent() {
        this.createPlaylistManagementHTML();
        this.setupEventListeners();
        this.loadPlaylists();
    }

    /**
     * Create the playlist management HTML structure
     */
    createPlaylistManagementHTML() {
        const container = document.getElementById('playlist-management');
        if (!container) return;

        container.innerHTML = `
            <div class="playlist-controls">
                <div class="search-filter-bar">
                    <div class="search-box">
                        <input type="text" id="playlist-search" placeholder="Search playlists..." class="search-input">
                        <span class="search-icon">🔍</span>
                    </div>
                    <div class="filter-controls">
                        <select id="playlist-sort" class="sort-select">
                            <option value="name">Sort by Name</option>
                            <option value="created_at">Sort by Date Created</option>
                            <option value="updated_at">Sort by Last Modified</option>
                            <option value="item_count">Sort by Item Count</option>
                        </select>
                        <button id="sort-order-btn" class="btn btn-secondary sort-order-btn" title="Toggle sort order">
                            <span class="sort-icon">↑</span>
                        </button>
                    </div>
                </div>
                <div class="playlist-stats">
                    <span id="playlist-count">0 playlists</span>
                    <span id="total-items">0 total items</span>
                </div>
            </div>

            <div class="playlist-list-container">
                <div id="playlist-list" class="playlist-list">
                    <div class="loading-playlists">Loading playlists...</div>
                </div>
            </div>

            <!-- Create/Edit Playlist Modal -->
            <div id="playlist-modal" class="modal hidden">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 id="modal-title">Create New Playlist</h3>
                        <button id="close-modal" class="modal-close">&times;</button>
                    </div>
                    <form id="playlist-form" class="modal-body">
                        <div class="form-group">
                            <label for="playlist-name">Playlist Name *</label>
                            <input type="text" id="playlist-name" name="name" required maxlength="100" 
                                   placeholder="Enter playlist name">
                            <div class="form-error" id="name-error"></div>
                        </div>
                        <div class="form-group">
                            <label for="playlist-description">Description</label>
                            <textarea id="playlist-description" name="description" rows="3" maxlength="500"
                                      placeholder="Optional description for this playlist"></textarea>
                            <div class="form-error" id="description-error"></div>
                        </div>
                    </form>
                    <div class="modal-footer">
                        <button type="button" id="cancel-playlist" class="btn btn-secondary">Cancel</button>
                        <button type="submit" id="save-playlist" class="btn btn-primary" form="playlist-form">
                            <span id="save-btn-text">Create Playlist</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- Delete Confirmation Modal -->
            <div id="delete-modal" class="modal hidden">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>Confirm Deletion</h3>
                        <button id="close-delete-modal" class="modal-close">&times;</button>
                    </div>
                    <div class="modal-body">
                        <p>Are you sure you want to delete the playlist "<strong id="delete-playlist-name"></strong>"?</p>
                        <p class="warning-text">This action cannot be undone. All playlist items will be removed.</p>
                    </div>
                    <div class="modal-footer">
                        <button type="button" id="cancel-delete" class="btn btn-secondary">Cancel</button>
                        <button type="button" id="confirm-delete" class="btn btn-danger">Delete Playlist</button>
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * Set up event listeners for playlist management
     */
    setupEventListeners() {
        // Search functionality
        const searchInput = document.getElementById('playlist-search');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchTerm = e.target.value.toLowerCase();
                this.filterAndSortPlaylists();
            });
        }

        // Sort functionality
        const sortSelect = document.getElementById('playlist-sort');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                this.sortBy = e.target.value;
                this.filterAndSortPlaylists();
            });
        }

        const sortOrderBtn = document.getElementById('sort-order-btn');
        if (sortOrderBtn) {
            sortOrderBtn.addEventListener('click', () => {
                this.sortOrder = this.sortOrder === 'asc' ? 'desc' : 'asc';
                const icon = sortOrderBtn.querySelector('.sort-icon');
                if (icon) {
                    icon.textContent = this.sortOrder === 'asc' ? '↑' : '↓';
                }
                this.filterAndSortPlaylists();
            });
        }

        // Modal event listeners
        this.setupModalEventListeners();
    }

    /**
     * Set up modal event listeners
     */
    setupModalEventListeners() {
        // Create/Edit modal
        const modal = document.getElementById('playlist-modal');
        const closeModal = document.getElementById('close-modal');
        const cancelBtn = document.getElementById('cancel-playlist');
        const form = document.getElementById('playlist-form');

        if (closeModal) {
            closeModal.addEventListener('click', () => this.hideModal());
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => this.hideModal());
        }
        if (form) {
            form.addEventListener('submit', (e) => this.handleFormSubmit(e));
        }

        // Delete confirmation modal
        const deleteModal = document.getElementById('delete-modal');
        const closeDeleteModal = document.getElementById('close-delete-modal');
        const cancelDelete = document.getElementById('cancel-delete');
        const confirmDelete = document.getElementById('confirm-delete');

        if (closeDeleteModal) {
            closeDeleteModal.addEventListener('click', () => this.hideDeleteModal());
        }
        if (cancelDelete) {
            cancelDelete.addEventListener('click', () => this.hideDeleteModal());
        }
        if (confirmDelete) {
            confirmDelete.addEventListener('click', () => this.confirmDeletePlaylist());
        }

        // Close modals when clicking outside
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.hideModal();
            });
        }
        if (deleteModal) {
            deleteModal.addEventListener('click', (e) => {
                if (e.target === deleteModal) this.hideDeleteModal();
            });
        }
    }

    /**
     * Load playlists from the server
     */
    async loadPlaylists() {
        try {
            const response = await window.apiClient.getPlaylists(true);
            this.playlists = response.data || [];
            this.filterAndSortPlaylists();
            this.updateStats();
        } catch (error) {
            console.error('Failed to load playlists:', error);
            this.showError('Failed to load playlists. Please try again.');
            this.playlists = [];
            this.renderPlaylists();
        }
    }

    /**
     * Filter and sort playlists based on current criteria
     */
    filterAndSortPlaylists() {
        // Filter by search term
        this.filteredPlaylists = this.playlists.filter(playlist => {
            if (!this.searchTerm) return true;
            return playlist.name.toLowerCase().includes(this.searchTerm) ||
                   (playlist.description && playlist.description.toLowerCase().includes(this.searchTerm));
        });

        // Sort playlists
        this.filteredPlaylists.sort((a, b) => {
            let aValue, bValue;
            
            switch (this.sortBy) {
                case 'name':
                    aValue = a.name.toLowerCase();
                    bValue = b.name.toLowerCase();
                    break;
                case 'created_at':
                    aValue = new Date(a.created_at);
                    bValue = new Date(b.created_at);
                    break;
                case 'updated_at':
                    aValue = new Date(a.updated_at);
                    bValue = new Date(b.updated_at);
                    break;
                case 'item_count':
                    aValue = a.items ? a.items.length : 0;
                    bValue = b.items ? b.items.length : 0;
                    break;
                default:
                    aValue = a.name.toLowerCase();
                    bValue = b.name.toLowerCase();
            }

            if (aValue < bValue) return this.sortOrder === 'asc' ? -1 : 1;
            if (aValue > bValue) return this.sortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        this.renderPlaylists();
        this.updateStats();
    }

    /**
     * Render the playlist list
     */
    renderPlaylists() {
        const container = document.getElementById('playlist-list');
        if (!container) return;

        if (this.filteredPlaylists.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">📋</div>
                    <h3>No playlists found</h3>
                    <p>${this.searchTerm ? 'Try adjusting your search terms.' : 'Create your first playlist to get started.'}</p>
                    ${!this.searchTerm ? '<button class="btn btn-primary" onclick="window.playlistManager.showCreateModal()">Create Playlist</button>' : ''}
                </div>
            `;
            return;
        }

        const playlistsHTML = this.filteredPlaylists.map(playlist => this.renderPlaylistCard(playlist)).join('');
        container.innerHTML = playlistsHTML;

        // Set up drag and drop for playlist items
        this.setupDragAndDrop();
    }

    /**
     * Render a single playlist card
     */
    renderPlaylistCard(playlist) {
        const itemCount = playlist.items ? playlist.items.length : 0;
        const isActive = window.app && window.app.activePlaylist && window.app.activePlaylist.id === playlist.id;
        
        return `
            <div class="playlist-card ${isActive ? 'active' : ''}" data-playlist-id="${playlist.id}">
                <div class="playlist-header">
                    <div class="playlist-info">
                        <h4 class="playlist-name">${this.escapeHtml(playlist.name)}</h4>
                        <p class="playlist-description">${playlist.description ? this.escapeHtml(playlist.description) : 'No description'}</p>
                    </div>
                    <div class="playlist-actions">
                        <button class="btn-icon" onclick="window.playlistManager.editPlaylist('${playlist.id}')" title="Edit playlist">
                            ✏️
                        </button>
                        <button class="btn-icon" onclick="window.playlistManager.activatePlaylist('${playlist.id}')" title="Activate playlist">
                            ${isActive ? '⏸️' : '▶️'}
                        </button>
                        <button class="btn-icon delete-btn" onclick="window.playlistManager.showDeleteModal('${playlist.id}')" title="Delete playlist">
                            🗑️
                        </button>
                    </div>
                </div>
                <div class="playlist-meta">
                    <span class="item-count">${itemCount} item${itemCount !== 1 ? 's' : ''}</span>
                    <span class="playlist-date">Updated ${this.formatDate(playlist.updated_at)}</span>
                    ${isActive ? '<span class="active-badge">ACTIVE</span>' : ''}
                </div>
                <div class="playlist-items" data-playlist-id="${playlist.id}">
                    ${this.renderPlaylistItems(playlist.items || [])}
                </div>
            </div>
        `;
    }

    /**
     * Render playlist items with drag-and-drop support
     */
    renderPlaylistItems(items) {
        if (items.length === 0) {
            return '<div class="no-items">No items in this playlist</div>';
        }

        return items.map((item, index) => `
            <div class="playlist-item" draggable="true" data-item-id="${item.id}" data-order="${item.order_index}">
                <div class="drag-handle">⋮⋮</div>
                <div class="item-info">
                    <span class="item-name">${this.escapeHtml(item.media_file?.original_name || 'Unknown file')}</span>
                    <span class="item-type">${item.media_file?.file_type || 'unknown'}</span>
                </div>
                <div class="item-actions">
                    <button class="btn-icon-small" onclick="window.playlistManager.removePlaylistItem('${item.playlist_id}', '${item.id}')" title="Remove from playlist">
                        ✕
                    </button>
                </div>
            </div>
        `).join('');
    }

    /**
     * Set up drag and drop functionality for playlist items
     */
    setupDragAndDrop() {
        const playlistItems = document.querySelectorAll('.playlist-item');
        
        playlistItems.forEach(item => {
            item.addEventListener('dragstart', (e) => {
                this.draggedItem = {
                    element: item,
                    itemId: item.dataset.itemId,
                    playlistId: item.closest('.playlist-items').dataset.playlistId,
                    originalOrder: parseInt(item.dataset.order)
                };
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                this.draggedItem = null;
            });

            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                if (this.draggedItem && this.draggedItem.element !== item) {
                    const rect = item.getBoundingClientRect();
                    const midY = rect.top + rect.height / 2;
                    
                    if (e.clientY < midY) {
                        item.classList.add('drop-above');
                        item.classList.remove('drop-below');
                    } else {
                        item.classList.add('drop-below');
                        item.classList.remove('drop-above');
                    }
                }
            });

            item.addEventListener('dragleave', () => {
                item.classList.remove('drop-above', 'drop-below');
            });

            item.addEventListener('drop', (e) => {
                e.preventDefault();
                item.classList.remove('drop-above', 'drop-below');
                
                if (this.draggedItem && this.draggedItem.element !== item) {
                    this.handleItemDrop(item, e.clientY);
                }
            });
        });
    }

    /**
     * Handle dropping a playlist item
     */
    async handleItemDrop(targetItem, clientY) {
        if (!this.draggedItem) return;

        const targetRect = targetItem.getBoundingClientRect();
        const targetMidY = targetRect.top + targetRect.height / 2;
        const dropAbove = clientY < targetMidY;
        
        const targetOrder = parseInt(targetItem.dataset.order);
        const newOrder = dropAbove ? targetOrder : targetOrder + 1;
        
        try {
            await this.reorderPlaylistItem(
                this.draggedItem.playlistId,
                this.draggedItem.itemId,
                newOrder
            );
            
            // Reload the playlist to reflect changes
            await this.loadPlaylists();
            window.apiClient.showSuccessToast('Playlist item reordered successfully');
        } catch (error) {
            console.error('Failed to reorder playlist item:', error);
            window.apiClient.showErrorToast('Failed to reorder playlist item');
        }
    }

    /**
     * Update playlist statistics
     */
    updateStats() {
        const playlistCount = document.getElementById('playlist-count');
        const totalItems = document.getElementById('total-items');
        
        if (playlistCount) {
            const count = this.filteredPlaylists.length;
            playlistCount.textContent = `${count} playlist${count !== 1 ? 's' : ''}`;
        }
        
        if (totalItems) {
            const total = this.playlists.reduce((sum, playlist) => {
                return sum + (playlist.items ? playlist.items.length : 0);
            }, 0);
            totalItems.textContent = `${total} total item${total !== 1 ? 's' : ''}`;
        }
    }

    /**
     * Show create playlist modal
     */
    showCreateModal() {
        this.selectedPlaylist = null;
        this.resetForm();
        
        const modal = document.getElementById('playlist-modal');
        const title = document.getElementById('modal-title');
        const saveBtn = document.getElementById('save-btn-text');
        
        if (title) title.textContent = 'Create New Playlist';
        if (saveBtn) saveBtn.textContent = 'Create Playlist';
        if (modal) modal.classList.remove('hidden');
        
        // Focus on name input
        const nameInput = document.getElementById('playlist-name');
        if (nameInput) {
            setTimeout(() => nameInput.focus(), 100);
        }
    }

    /**
     * Show edit playlist modal
     */
    async editPlaylist(playlistId) {
        try {
            const response = await window.apiClient.getPlaylist(playlistId);
            this.selectedPlaylist = response.data;
            
            const modal = document.getElementById('playlist-modal');
            const title = document.getElementById('modal-title');
            const saveBtn = document.getElementById('save-btn-text');
            const nameInput = document.getElementById('playlist-name');
            const descInput = document.getElementById('playlist-description');
            
            if (title) title.textContent = 'Edit Playlist';
            if (saveBtn) saveBtn.textContent = 'Save Changes';
            if (nameInput) nameInput.value = this.selectedPlaylist.name;
            if (descInput) descInput.value = this.selectedPlaylist.description || '';
            if (modal) modal.classList.remove('hidden');
            
            // Focus on name input
            if (nameInput) {
                setTimeout(() => nameInput.focus(), 100);
            }
        } catch (error) {
            console.error('Failed to load playlist for editing:', error);
            window.apiClient.showErrorToast('Failed to load playlist details');
        }
    }

    /**
     * Handle form submission
     */
    async handleFormSubmit(e) {
        e.preventDefault();
        
        const formData = new FormData(e.target);
        const data = {
            name: formData.get('name').trim(),
            description: formData.get('description').trim()
        };
        
        // Validate form
        if (!this.validateForm(data)) {
            return;
        }
        
        try {
            window.apiClient.showLoading();
            
            if (this.selectedPlaylist) {
                // Update existing playlist
                await window.apiClient.updatePlaylist(this.selectedPlaylist.id, data);
                window.apiClient.showSuccessToast('Playlist updated successfully');
            } else {
                // Create new playlist
                await window.apiClient.createPlaylist(data);
                window.apiClient.showSuccessToast('Playlist created successfully');
            }
            
            this.hideModal();
            await this.loadPlaylists();
        } catch (error) {
            console.error('Failed to save playlist:', error);
            window.apiClient.showErrorToast('Failed to save playlist');
        } finally {
            window.apiClient.hideLoading();
        }
    }

    /**
     * Validate form data
     */
    validateForm(data) {
        let isValid = true;
        
        // Clear previous errors
        document.querySelectorAll('.form-error').forEach(el => el.textContent = '');
        
        // Validate name
        if (!data.name) {
            document.getElementById('name-error').textContent = 'Playlist name is required';
            isValid = false;
        } else if (data.name.length > 100) {
            document.getElementById('name-error').textContent = 'Playlist name must be 100 characters or less';
            isValid = false;
        }
        
        // Validate description length
        if (data.description && data.description.length > 500) {
            document.getElementById('description-error').textContent = 'Description must be 500 characters or less';
            isValid = false;
        }
        
        return isValid;
    }

    /**
     * Show delete confirmation modal
     */
    showDeleteModal(playlistId) {
        const playlist = this.playlists.find(p => p.id === playlistId);
        if (!playlist) return;
        
        this.selectedPlaylist = playlist;
        
        const modal = document.getElementById('delete-modal');
        const nameSpan = document.getElementById('delete-playlist-name');
        
        if (nameSpan) nameSpan.textContent = playlist.name;
        if (modal) modal.classList.remove('hidden');
    }

    /**
     * Confirm playlist deletion
     */
    async confirmDeletePlaylist() {
        if (!this.selectedPlaylist) return;
        
        try {
            window.apiClient.showLoading();
            await window.apiClient.deletePlaylist(this.selectedPlaylist.id);
            
            this.hideDeleteModal();
            await this.loadPlaylists();
            window.apiClient.showSuccessToast('Playlist deleted successfully');
        } catch (error) {
            console.error('Failed to delete playlist:', error);
            window.apiClient.showErrorToast('Failed to delete playlist');
        } finally {
            window.apiClient.hideLoading();
        }
    }

    /**
     * Activate/deactivate playlist
     */
    async activatePlaylist(playlistId) {
        try {
            const isCurrentlyActive = window.app && window.app.activePlaylist && window.app.activePlaylist.id === playlistId;
            
            if (isCurrentlyActive) {
                // Deactivate current playlist
                await window.apiClient.activatePlaylist(null);
            } else {
                // Activate selected playlist
                await window.apiClient.activatePlaylist(playlistId);
            }
            
            // The WebSocket will handle updating the UI
        } catch (error) {
            console.error('Failed to activate playlist:', error);
            window.apiClient.showErrorToast('Failed to change playlist activation');
        }
    }

    /**
     * Remove item from playlist
     */
    async removePlaylistItem(playlistId, itemId) {
        if (!confirm('Remove this item from the playlist?')) {
            return;
        }
        
        try {
            await window.apiClient.deletePlaylistItem(playlistId, itemId);
            await this.loadPlaylists();
            window.apiClient.showSuccessToast('Item removed from playlist');
        } catch (error) {
            console.error('Failed to remove playlist item:', error);
            window.apiClient.showErrorToast('Failed to remove item from playlist');
        }
    }

    /**
     * Reorder playlist item
     */
    async reorderPlaylistItem(playlistId, itemId, newOrder) {
        return window.apiClient.updatePlaylistItem(playlistId, itemId, {
            order_index: newOrder
        });
    }

    /**
     * Hide create/edit modal
     */
    hideModal() {
        const modal = document.getElementById('playlist-modal');
        if (modal) modal.classList.add('hidden');
        this.resetForm();
    }

    /**
     * Hide delete confirmation modal
     */
    hideDeleteModal() {
        const modal = document.getElementById('delete-modal');
        if (modal) modal.classList.add('hidden');
        this.selectedPlaylist = null;
    }

    /**
     * Reset form to initial state
     */
    resetForm() {
        const form = document.getElementById('playlist-form');
        if (form) form.reset();
        
        // Clear errors
        document.querySelectorAll('.form-error').forEach(el => el.textContent = '');
        
        this.selectedPlaylist = null;
    }

    /**
     * Show error message
     */
    showError(message) {
        const container = document.getElementById('playlist-list');
        if (container) {
            container.innerHTML = `
                <div class="error-state">
                    <div class="error-icon">⚠️</div>
                    <h3>Error Loading Playlists</h3>
                    <p>${message}</p>
                    <button class="btn btn-primary" onclick="window.playlistManager.loadPlaylists()">Try Again</button>
                </div>
            `;
        }
    }

    /**
     * Utility: Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Utility: Format date for display
     */
    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) {
            return 'Today';
        } else if (diffDays === 1) {
            return 'Yesterday';
        } else if (diffDays < 7) {
            return `${diffDays} days ago`;
        } else {
            return date.toLocaleDateString();
        }
    }

    /**
     * Refresh playlists data
     */
    async refresh() {
        await this.loadPlaylists();
    }

    /**
     * Get current state for debugging
     */
    getState() {
        return {
            playlists: this.playlists.length,
            filtered: this.filteredPlaylists.length,
            searchTerm: this.searchTerm,
            sortBy: this.sortBy,
            sortOrder: this.sortOrder
        };
    }
}

// Export for global access
window.PlaylistManager = PlaylistManager;