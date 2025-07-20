/**
 * Media Manager for handling file uploads, preview, and library management
 * Implements drag-and-drop upload, preview modal, and media library grid
 */
class MediaManager {
    constructor() {
        this.mediaFiles = [];
        this.selectedFiles = [];
        this.uploadQueue = [];
        this.isUploading = false;
        this.previewModal = null;
        this.uploadModal = null;
        
        this.initializeMediaManager();
    }

    /**
     * Initialize the media manager
     */
    async initializeMediaManager() {
        console.log('Initializing Media Manager');
        
        // Create modals
        this.createUploadModal();
        this.createPreviewModal();
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Load initial media files
        await this.loadMediaFiles();
        
        // Render media library
        this.renderMediaLibrary();
        
        console.log('Media Manager initialized successfully');
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        // Upload button
        const uploadBtn = document.getElementById('upload-media-btn');
        if (uploadBtn) {
            uploadBtn.addEventListener('click', () => {
                this.showUploadModal();
            });
        }

        // Drag and drop on media section
        const mediaSection = document.getElementById('media-section');
        if (mediaSection) {
            mediaSection.addEventListener('dragover', this.handleDragOver.bind(this));
            mediaSection.addEventListener('drop', this.handleDrop.bind(this));
            mediaSection.addEventListener('dragenter', this.handleDragEnter.bind(this));
            mediaSection.addEventListener('dragleave', this.handleDragLeave.bind(this));
        }
    }

    /**
     * Load media files from server
     */
    async loadMediaFiles() {
        try {
            const response = await window.apiClient.getMediaFiles();
            this.mediaFiles = response.data || [];
            console.log(`Loaded ${this.mediaFiles.length} media files`);
        } catch (error) {
            console.error('Failed to load media files:', error);
            window.apiClient.handleApiError(error, 'loading media files');
            this.mediaFiles = [];
        }
    }

    /**
     * Render media library grid
     */
    renderMediaLibrary() {
        const mediaUploadDiv = document.getElementById('media-upload');
        if (!mediaUploadDiv) return;

        if (this.mediaFiles.length === 0) {
            mediaUploadDiv.innerHTML = this.renderEmptyState();
            return;
        }

        const html = `
            <div class="media-library-header">
                <div class="media-stats">
                    <span class="stat-item">
                        <strong>${this.mediaFiles.length}</strong> files
                    </span>
                    <span class="stat-item">
                        <strong>${this.mediaFiles.filter(f => f.file_type === 'video').length}</strong> videos
                    </span>
                    <span class="stat-item">
                        <strong>${this.mediaFiles.filter(f => f.file_type === 'image').length}</strong> images
                    </span>
                </div>
                <div class="media-controls">
                    <select id="media-filter" class="media-filter-select">
                        <option value="all">All Media</option>
                        <option value="video">Videos Only</option>
                        <option value="image">Images Only</option>
                    </select>
                    <select id="media-sort" class="media-sort-select">
                        <option value="newest">Newest First</option>
                        <option value="oldest">Oldest First</option>
                        <option value="name">Name A-Z</option>
                        <option value="size">Size</option>
                    </select>
                </div>
            </div>
            <div class="media-grid" id="media-grid">
                ${this.renderMediaGrid()}
            </div>
        `;

        mediaUploadDiv.innerHTML = html;

        // Add event listeners for controls
        this.setupMediaControls();
    }

    /**
     * Render media grid items
     */
    renderMediaGrid() {
        return this.mediaFiles.map(file => this.renderMediaItem(file)).join('');
    }

    /**
     * Render individual media item
     */
    renderMediaItem(file) {
        const thumbnailUrl = window.apiClient.getThumbnailUrl(file) || this.getDefaultThumbnail(file.file_type);
        const fileSize = this.formatFileSize(file.file_size);
        const uploadDate = new Date(file.created_at).toLocaleDateString();
        
        return `
            <div class="media-item" data-file-id="${file.id}" data-file-type="${file.file_type}">
                <div class="media-thumbnail" onclick="mediaManager.previewMedia('${file.id}')">
                    ${file.file_type === 'video' ? 
                        `<img src="${thumbnailUrl}" alt="${file.original_name}" onerror="this.src='${this.getDefaultThumbnail('video')}'">
                         <div class="video-overlay">
                             <div class="play-icon">▶</div>
                             ${file.duration ? `<div class="duration">${this.formatDuration(file.duration)}</div>` : ''}
                         </div>` :
                        `<img src="${thumbnailUrl}" alt="${file.original_name}" onerror="this.src='${this.getDefaultThumbnail('image')}'>">`
                    }
                </div>
                <div class="media-info">
                    <div class="media-name" title="${file.original_name}">${file.original_name}</div>
                    <div class="media-meta">
                        <span class="file-type">${file.file_type.toUpperCase()}</span>
                        <span class="file-size">${fileSize}</span>
                        <span class="upload-date">${uploadDate}</span>
                    </div>
                </div>
                <div class="media-actions">
                    <button class="btn-icon" onclick="mediaManager.previewMedia('${file.id}')" title="Preview">
                        👁
                    </button>
                    <button class="btn-icon" onclick="mediaManager.downloadMedia('${file.id}')" title="Download">
                        ⬇
                    </button>
                    <button class="btn-icon delete-btn" onclick="mediaManager.deleteMedia('${file.id}')" title="Delete">
                        🗑
                    </button>
                </div>
            </div>
        `;
    }

    /**
     * Render empty state
     */
    renderEmptyState() {
        return `
            <div class="empty-state">
                <div class="empty-icon">📁</div>
                <h3>No Media Files</h3>
                <p>Upload your first video or image file to get started.</p>
                <button class="btn btn-primary" onclick="mediaManager.showUploadModal()">
                    Upload Media Files
                </button>
            </div>
        `;
    }

    /**
     * Set up media controls event listeners
     */
    setupMediaControls() {
        const filterSelect = document.getElementById('media-filter');
        const sortSelect = document.getElementById('media-sort');

        if (filterSelect) {
            filterSelect.addEventListener('change', () => {
                this.filterAndSortMedia();
            });
        }

        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                this.filterAndSortMedia();
            });
        }
    }

    /**
     * Filter and sort media files
     */
    filterAndSortMedia() {
        const filterSelect = document.getElementById('media-filter');
        const sortSelect = document.getElementById('media-sort');
        
        if (!filterSelect || !sortSelect) return;

        const filterValue = filterSelect.value;
        const sortValue = sortSelect.value;

        // Filter files
        let filteredFiles = this.mediaFiles;
        if (filterValue !== 'all') {
            filteredFiles = this.mediaFiles.filter(file => file.file_type === filterValue);
        }

        // Sort files
        filteredFiles.sort((a, b) => {
            switch (sortValue) {
                case 'newest':
                    return new Date(b.created_at) - new Date(a.created_at);
                case 'oldest':
                    return new Date(a.created_at) - new Date(b.created_at);
                case 'name':
                    return a.original_name.localeCompare(b.original_name);
                case 'size':
                    return b.file_size - a.file_size;
                default:
                    return 0;
            }
        });

        // Update grid
        const mediaGrid = document.getElementById('media-grid');
        if (mediaGrid) {
            mediaGrid.innerHTML = filteredFiles.map(file => this.renderMediaItem(file)).join('');
        }
    }

    /**
     * Create upload modal
     */
    createUploadModal() {
        const modalHtml = `
            <div id="upload-modal" class="modal hidden">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>Upload Media Files</h3>
                        <button class="modal-close" onclick="mediaManager.hideUploadModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="upload-area" id="upload-area">
                            <div class="upload-drop-zone" id="upload-drop-zone">
                                <div class="upload-icon">📁</div>
                                <h4>Drag & Drop Files Here</h4>
                                <p>or click to select files</p>
                                <input type="file" id="file-input" multiple accept="video/*,image/*" style="display: none;">
                                <button class="btn btn-primary" onclick="document.getElementById('file-input').click()">
                                    Select Files
                                </button>
                            </div>
                        </div>
                        <div class="upload-queue" id="upload-queue" style="display: none;">
                            <h4>Upload Queue</h4>
                            <div class="queue-items" id="queue-items"></div>
                        </div>
                        <div class="upload-validation" id="upload-validation">
                            <h5>Supported Formats:</h5>
                            <div class="format-info">
                                <div><strong>Videos:</strong> MP4, AVI, MOV, WebM</div>
                                <div><strong>Images:</strong> JPG, PNG, GIF, WebP</div>
                                <div><strong>Max Size:</strong> 100MB per file</div>
                            </div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="mediaManager.hideUploadModal()">Cancel</button>
                        <button class="btn btn-primary" id="start-upload-btn" onclick="mediaManager.startUpload()" disabled>
                            Upload Files
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
        this.uploadModal = document.getElementById('upload-modal');

        // Set up upload modal event listeners
        this.setupUploadModalListeners();
    }

    /**
     * Set up upload modal event listeners
     */
    setupUploadModalListeners() {
        const fileInput = document.getElementById('file-input');
        const dropZone = document.getElementById('upload-drop-zone');

        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                this.handleFileSelection(Array.from(e.target.files));
            });
        }

        if (dropZone) {
            dropZone.addEventListener('dragover', this.handleModalDragOver.bind(this));
            dropZone.addEventListener('drop', this.handleModalDrop.bind(this));
            dropZone.addEventListener('dragenter', this.handleModalDragEnter.bind(this));
            dropZone.addEventListener('dragleave', this.handleModalDragLeave.bind(this));
        }
    }

    /**
     * Create preview modal
     */
    createPreviewModal() {
        const modalHtml = `
            <div id="preview-modal" class="modal hidden">
                <div class="modal-content preview-modal-content">
                    <div class="modal-header">
                        <h3 id="preview-title">Media Preview</h3>
                        <button class="modal-close" onclick="mediaManager.hidePreviewModal()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="preview-container" id="preview-container">
                            <!-- Media content will be inserted here -->
                        </div>
                        <div class="preview-info" id="preview-info">
                            <!-- File info will be inserted here -->
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="mediaManager.hidePreviewModal()">Close</button>
                        <button class="btn btn-primary" id="add-to-playlist-btn" onclick="mediaManager.showAddToPlaylistDialog()">
                            Add to Playlist
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', modalHtml);
        this.previewModal = document.getElementById('preview-modal');
    }

    /**
     * Show upload modal
     */
    showUploadModal() {
        if (this.uploadModal) {
            this.uploadModal.classList.remove('hidden');
            this.resetUploadModal();
        }
    }

    /**
     * Hide upload modal
     */
    hideUploadModal() {
        if (this.uploadModal) {
            this.uploadModal.classList.add('hidden');
            this.resetUploadModal();
        }
    }

    /**
     * Reset upload modal state
     */
    resetUploadModal() {
        this.selectedFiles = [];
        this.uploadQueue = [];
        
        const fileInput = document.getElementById('file-input');
        const uploadQueue = document.getElementById('upload-queue');
        const startUploadBtn = document.getElementById('start-upload-btn');
        
        if (fileInput) fileInput.value = '';
        if (uploadQueue) uploadQueue.style.display = 'none';
        if (startUploadBtn) startUploadBtn.disabled = true;
    }

    /**
     * Handle file selection
     */
    handleFileSelection(files) {
        const validFiles = [];
        const errors = [];

        files.forEach(file => {
            const validation = this.validateFile(file);
            if (validation.valid) {
                validFiles.push(file);
            } else {
                errors.push(`${file.name}: ${validation.error}`);
            }
        });

        if (errors.length > 0) {
            window.apiClient.showErrorToast(`File validation errors:\n${errors.join('\n')}`);
        }

        if (validFiles.length > 0) {
            this.selectedFiles = validFiles;
            this.displayUploadQueue();
            
            const startUploadBtn = document.getElementById('start-upload-btn');
            if (startUploadBtn) {
                startUploadBtn.disabled = false;
            }
        }
    }

    /**
     * Validate file
     */
    validateFile(file) {
        const maxSize = 100 * 1024 * 1024; // 100MB
        const videoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/webm'];
        const imageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        const allowedTypes = [...videoTypes, ...imageTypes];

        if (file.size > maxSize) {
            return { valid: false, error: 'File size exceeds 100MB limit' };
        }

        if (!allowedTypes.includes(file.type)) {
            return { valid: false, error: 'Unsupported file format' };
        }

        return { valid: true };
    }

    /**
     * Display upload queue
     */
    displayUploadQueue() {
        const uploadQueue = document.getElementById('upload-queue');
        const queueItems = document.getElementById('queue-items');

        if (!uploadQueue || !queueItems) return;

        const queueHtml = this.selectedFiles.map((file, index) => `
            <div class="queue-item" data-index="${index}">
                <div class="queue-item-info">
                    <div class="queue-item-name">${file.name}</div>
                    <div class="queue-item-meta">
                        ${this.formatFileSize(file.size)} • ${file.type}
                    </div>
                </div>
                <div class="queue-item-actions">
                    <button class="btn-icon-small" onclick="mediaManager.removeFromQueue(${index})" title="Remove">
                        ✕
                    </button>
                </div>
                <div class="queue-item-progress" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: 0%"></div>
                    </div>
                    <div class="progress-text">0%</div>
                </div>
            </div>
        `).join('');

        queueItems.innerHTML = queueHtml;
        uploadQueue.style.display = 'block';
    }

    /**
     * Remove file from upload queue
     */
    removeFromQueue(index) {
        this.selectedFiles.splice(index, 1);
        
        if (this.selectedFiles.length === 0) {
            const uploadQueue = document.getElementById('upload-queue');
            const startUploadBtn = document.getElementById('start-upload-btn');
            
            if (uploadQueue) uploadQueue.style.display = 'none';
            if (startUploadBtn) startUploadBtn.disabled = true;
        } else {
            this.displayUploadQueue();
        }
    }

    /**
     * Start file upload
     */
    async startUpload() {
        if (this.isUploading || this.selectedFiles.length === 0) return;

        this.isUploading = true;
        const startUploadBtn = document.getElementById('start-upload-btn');
        if (startUploadBtn) {
            startUploadBtn.disabled = true;
            startUploadBtn.textContent = 'Uploading...';
        }

        try {
            for (let i = 0; i < this.selectedFiles.length; i++) {
                await this.uploadSingleFile(this.selectedFiles[i], i);
            }

            window.apiClient.showSuccessToast(`Successfully uploaded ${this.selectedFiles.length} files`);
            this.hideUploadModal();
            await this.loadMediaFiles();
            this.renderMediaLibrary();

        } catch (error) {
            console.error('Upload failed:', error);
            window.apiClient.handleApiError(error, 'uploading files');
        } finally {
            this.isUploading = false;
            if (startUploadBtn) {
                startUploadBtn.disabled = false;
                startUploadBtn.textContent = 'Upload Files';
            }
        }
    }

    /**
     * Upload single file with progress tracking
     */
    async uploadSingleFile(file, index) {
        const queueItem = document.querySelector(`[data-index="${index}"]`);
        const progressContainer = queueItem?.querySelector('.queue-item-progress');
        const progressFill = queueItem?.querySelector('.progress-fill');
        const progressText = queueItem?.querySelector('.progress-text');

        if (progressContainer) {
            progressContainer.style.display = 'block';
        }

        return window.apiClient.uploadMediaFile(file, (progress) => {
            if (progressFill && progressText) {
                progressFill.style.width = `${progress}%`;
                progressText.textContent = `${Math.round(progress)}%`;
            }
        });
    }

    /**
     * Preview media file
     */
    async previewMedia(fileId) {
        try {
            const response = await window.apiClient.getMediaFile(fileId);
            const file = response.data;
            
            this.showPreviewModal(file);
        } catch (error) {
            console.error('Failed to load media file:', error);
            window.apiClient.handleApiError(error, 'loading media file');
        }
    }

    /**
     * Show preview modal
     */
    showPreviewModal(file) {
        if (!this.previewModal) return;

        const previewTitle = document.getElementById('preview-title');
        const previewContainer = document.getElementById('preview-container');
        const previewInfo = document.getElementById('preview-info');

        if (previewTitle) {
            previewTitle.textContent = file.original_name;
        }

        if (previewContainer) {
            const mediaUrl = window.apiClient.getMediaUrl(file);
            
            if (file.file_type === 'video') {
                previewContainer.innerHTML = `
                    <video controls class="preview-media">
                        <source src="${mediaUrl}" type="${file.mime_type}">
                        Your browser does not support the video tag.
                    </video>
                `;
            } else {
                previewContainer.innerHTML = `
                    <img src="${mediaUrl}" alt="${file.original_name}" class="preview-media">
                `;
            }
        }

        if (previewInfo) {
            previewInfo.innerHTML = `
                <div class="preview-details">
                    <div class="detail-row">
                        <span class="detail-label">File Name:</span>
                        <span class="detail-value">${file.original_name}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">File Type:</span>
                        <span class="detail-value">${file.file_type.toUpperCase()}</span>
                    </div>
                    <div class="detail-row">
                        <span class="detail-label">File Size:</span>
                        <span class="detail-value">${this.formatFileSize(file.file_size)}</span>
                    </div>
                    ${file.duration ? `
                        <div class="detail-row">
                            <span class="detail-label">Duration:</span>
                            <span class="detail-value">${this.formatDuration(file.duration)}</span>
                        </div>
                    ` : ''}
                    <div class="detail-row">
                        <span class="detail-label">Uploaded:</span>
                        <span class="detail-value">${new Date(file.created_at).toLocaleString()}</span>
                    </div>
                </div>
            `;
        }

        this.previewModal.classList.remove('hidden');
    }

    /**
     * Hide preview modal
     */
    hidePreviewModal() {
        if (this.previewModal) {
            this.previewModal.classList.add('hidden');
            
            // Stop any playing video
            const video = this.previewModal.querySelector('video');
            if (video) {
                video.pause();
            }
        }
    }

    /**
     * Delete media file
     */
    async deleteMedia(fileId) {
        const file = this.mediaFiles.find(f => f.id === fileId);
        if (!file) return;

        const confirmed = confirm(`Are you sure you want to delete "${file.original_name}"?\n\nThis action cannot be undone and will remove the file from all playlists.`);
        if (!confirmed) return;

        try {
            await window.apiClient.deleteMediaFile(fileId);
            window.apiClient.showSuccessToast(`Deleted "${file.original_name}"`);
            
            // Reload media files and refresh display
            await this.loadMediaFiles();
            this.renderMediaLibrary();
            
        } catch (error) {
            console.error('Failed to delete media file:', error);
            window.apiClient.handleApiError(error, 'deleting media file');
        }
    }

    /**
     * Download media file
     */
    downloadMedia(fileId) {
        const file = this.mediaFiles.find(f => f.id === fileId);
        if (!file) return;

        const mediaUrl = window.apiClient.getMediaUrl(file);
        const link = document.createElement('a');
        link.href = mediaUrl;
        link.download = file.original_name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    /**
     * Show add to playlist dialog (placeholder)
     */
    showAddToPlaylistDialog() {
        window.apiClient.showErrorToast('Add to playlist functionality will be implemented in a future task.');
    }

    // Drag and drop handlers for main media section
    handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    handleDragEnter(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.add('drag-over');
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget)) {
            e.currentTarget.classList.remove('drag-over');
        }
    }

    handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            this.showUploadModal();
            setTimeout(() => {
                this.handleFileSelection(files);
            }, 100);
        }
    }

    // Drag and drop handlers for upload modal
    handleModalDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    handleModalDragEnter(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.add('drag-over');
    }

    handleModalDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.currentTarget.contains(e.relatedTarget)) {
            e.currentTarget.classList.remove('drag-over');
        }
    }

    handleModalDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.classList.remove('drag-over');
        
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) {
            this.handleFileSelection(files);
        }
    }

    // Utility methods
    formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        
        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        }
    }

    getDefaultThumbnail(fileType) {
        return fileType === 'video' ? 
            'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjE1MCIgdmlld0JveD0iMCAwIDIwMCAxNTAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMTUwIiBmaWxsPSIjRjhGOUZBIi8+CjxwYXRoIGQ9Ik04MCA2MEwxMjAgOTBMODAgMTIwVjYwWiIgZmlsbD0iIzZDNzU3RCIvPgo8L3N2Zz4K' :
            'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjE1MCIgdmlld0JveD0iMCAwIDIwMCAxNTAiIGZpbGw9Im5vbmUiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+CjxyZWN0IHdpZHRoPSIyMDAiIGhlaWdodD0iMTUwIiBmaWxsPSIjRjhGOUZBIi8+CjxyZWN0IHg9IjQwIiB5PSI0MCIgd2lkdGg9IjEyMCIgaGVpZ2h0PSI3MCIgcng9IjQiIGZpbGw9IiM2Qzc1N0QiLz4KPGNpcmNsZSBjeD0iNzAiIGN5PSI2NSIgcj0iMTAiIGZpbGw9IndoaXRlIi8+CjxwYXRoIGQ9Ik0xMzAgOTBMMTUwIDcwTDE0MCA2MEwxMzAgNzBMMTIwIDYwTDEwMCA4MEwxMzAgOTBaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4K';
    }

    /**
     * Refresh media library
     */
    async refresh() {
        await this.loadMediaFiles();
        this.renderMediaLibrary();
    }
}

// Export for global access
window.MediaManager = MediaManager;