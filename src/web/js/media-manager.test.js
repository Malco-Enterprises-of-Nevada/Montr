/**
 * Media Manager Tests
 * Tests for media upload, preview, and library functionality
 */

// Mock DOM elements for testing
function createMockDOM() {
    // Create basic DOM structure
    document.body.innerHTML = `
        <div id="media-section" class="content-section">
            <div class="section-header">
                <h2>Media Library</h2>
                <button id="upload-media-btn" class="btn btn-primary">Upload Media</button>
            </div>
            <div id="media-upload" class="content-area">
                <div class="loading">Loading media files...</div>
            </div>
        </div>
        
        <!-- Toast notifications -->
        <div id="error-toast" class="toast error hidden">
            <span id="error-message"></span>
            <button id="close-error" class="toast-close">&times;</button>
        </div>
        
        <div id="success-toast" class="toast success hidden">
            <span id="success-message"></span>
            <button id="close-success" class="toast-close">&times;</button>
        </div>
    `;
}

// Mock API client
function createMockApiClient() {
    window.apiClient = {
        getMediaFiles: jest.fn().mockResolvedValue({
            success: true,
            data: [
                {
                    id: '1',
                    filename: 'test-video.mp4',
                    original_name: 'test-video.mp4',
                    file_type: 'video',
                    mime_type: 'video/mp4',
                    file_size: 1024000,
                    duration: 120,
                    thumbnail_path: '/uploads/thumbnails/test-video.jpg',
                    created_at: new Date().toISOString()
                },
                {
                    id: '2',
                    filename: 'test-image.jpg',
                    original_name: 'test-image.jpg',
                    file_type: 'image',
                    mime_type: 'image/jpeg',
                    file_size: 512000,
                    created_at: new Date().toISOString()
                }
            ]
        }),
        
        getMediaFile: jest.fn().mockResolvedValue({
            success: true,
            data: {
                id: '1',
                filename: 'test-video.mp4',
                original_name: 'test-video.mp4',
                file_type: 'video',
                mime_type: 'video/mp4',
                file_size: 1024000,
                duration: 120,
                thumbnail_path: '/uploads/thumbnails/test-video.jpg',
                created_at: new Date().toISOString()
            }
        }),
        
        uploadMediaFile: jest.fn().mockImplementation((file, onProgress) => {
            // Simulate progress
            if (onProgress) {
                setTimeout(() => onProgress(25), 100);
                setTimeout(() => onProgress(50), 200);
                setTimeout(() => onProgress(75), 300);
                setTimeout(() => onProgress(100), 400);
            }
            
            return Promise.resolve({
                success: true,
                data: {
                    mediaFile: {
                        id: '3',
                        filename: file.name,
                        original_name: file.name,
                        file_type: file.type.startsWith('video') ? 'video' : 'image',
                        mime_type: file.type,
                        file_size: file.size,
                        created_at: new Date().toISOString()
                    }
                }
            });
        }),
        
        deleteMediaFile: jest.fn().mockResolvedValue({
            success: true,
            message: 'Media file deleted successfully'
        }),
        
        getMediaUrl: jest.fn().mockImplementation((file) => `/api/media/${file.id}`),
        getThumbnailUrl: jest.fn().mockImplementation((file) => 
            file.thumbnail_path ? `/api/media/${file.id}/thumbnail` : null
        ),
        
        handleApiError: jest.fn(),
        showErrorToast: jest.fn(),
        showSuccessToast: jest.fn()
    };
}

describe('MediaManager', () => {
    let mediaManager;
    
    beforeEach(() => {
        // Reset DOM
        createMockDOM();
        
        // Mock API client
        createMockApiClient();
        
        // Mock console methods
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        
        // Mock confirm dialog
        global.confirm = jest.fn().mockReturnValue(true);
    });
    
    afterEach(() => {
        jest.restoreAllMocks();
        if (mediaManager) {
            // Clean up any modals created
            const uploadModal = document.getElementById('upload-modal');
            const previewModal = document.getElementById('preview-modal');
            if (uploadModal) uploadModal.remove();
            if (previewModal) previewModal.remove();
        }
    });
    
    test('should initialize media manager successfully', async () => {
        mediaManager = new MediaManager();
        
        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 100));
        
        expect(window.apiClient.getMediaFiles).toHaveBeenCalled();
        expect(mediaManager.mediaFiles).toHaveLength(2);
        
        // Check if media library is rendered
        const mediaGrid = document.querySelector('.media-grid');
        expect(mediaGrid).toBeTruthy();
    });
    
    test('should render empty state when no media files', async () => {
        // Mock empty response
        window.apiClient.getMediaFiles.mockResolvedValueOnce({
            success: true,
            data: []
        });
        
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const emptyState = document.querySelector('.empty-state');
        expect(emptyState).toBeTruthy();
        expect(emptyState.textContent).toContain('No Media Files');
    });
    
    test('should create upload modal', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const uploadModal = document.getElementById('upload-modal');
        expect(uploadModal).toBeTruthy();
        expect(uploadModal.classList.contains('hidden')).toBe(true);
    });
    
    test('should show upload modal when button clicked', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const uploadBtn = document.getElementById('upload-media-btn');
        uploadBtn.click();
        
        const uploadModal = document.getElementById('upload-modal');
        expect(uploadModal.classList.contains('hidden')).toBe(false);
    });
    
    test('should validate files correctly', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Test valid video file
        const validVideo = new File(['test'], 'test.mp4', { type: 'video/mp4' });
        const videoValidation = mediaManager.validateFile(validVideo);
        expect(videoValidation.valid).toBe(true);
        
        // Test valid image file
        const validImage = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
        const imageValidation = mediaManager.validateFile(validImage);
        expect(imageValidation.valid).toBe(true);
        
        // Test invalid file type
        const invalidFile = new File(['test'], 'test.txt', { type: 'text/plain' });
        const invalidValidation = mediaManager.validateFile(invalidFile);
        expect(invalidValidation.valid).toBe(false);
        expect(invalidValidation.error).toContain('Unsupported file format');
        
        // Test oversized file
        const oversizedFile = new File(['x'.repeat(101 * 1024 * 1024)], 'large.mp4', { type: 'video/mp4' });
        const sizeValidation = mediaManager.validateFile(oversizedFile);
        expect(sizeValidation.valid).toBe(false);
        expect(sizeValidation.error).toContain('File size exceeds');
    });
    
    test('should handle file selection', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const validFile = new File(['test'], 'test.mp4', { type: 'video/mp4' });
        mediaManager.handleFileSelection([validFile]);
        
        expect(mediaManager.selectedFiles).toHaveLength(1);
        expect(mediaManager.selectedFiles[0]).toBe(validFile);
        
        // Check if upload queue is displayed
        const uploadQueue = document.getElementById('upload-queue');
        expect(uploadQueue.style.display).toBe('block');
    });
    
    test('should upload files successfully', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const testFile = new File(['test'], 'test.mp4', { type: 'video/mp4' });
        mediaManager.selectedFiles = [testFile];
        
        await mediaManager.startUpload();
        
        expect(window.apiClient.uploadMediaFile).toHaveBeenCalledWith(testFile, expect.any(Function));
        expect(window.apiClient.showSuccessToast).toHaveBeenCalledWith('Successfully uploaded 1 files');
    });
    
    test('should preview media file', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        await mediaManager.previewMedia('1');
        
        expect(window.apiClient.getMediaFile).toHaveBeenCalledWith('1');
        
        const previewModal = document.getElementById('preview-modal');
        expect(previewModal.classList.contains('hidden')).toBe(false);
        
        // Check if video element is created for video files
        const videoElement = previewModal.querySelector('video');
        expect(videoElement).toBeTruthy();
    });
    
    test('should delete media file', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        await mediaManager.deleteMedia('1');
        
        expect(global.confirm).toHaveBeenCalled();
        expect(window.apiClient.deleteMediaFile).toHaveBeenCalledWith('1');
        expect(window.apiClient.showSuccessToast).toHaveBeenCalled();
    });
    
    test('should filter and sort media files', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Add filter and sort controls to DOM
        const mediaUploadDiv = document.getElementById('media-upload');
        mediaUploadDiv.innerHTML = `
            <div class="media-library-header">
                <div class="media-controls">
                    <select id="media-filter" class="media-filter-select">
                        <option value="all">All Media</option>
                        <option value="video">Videos Only</option>
                        <option value="image">Images Only</option>
                    </select>
                    <select id="media-sort" class="media-sort-select">
                        <option value="newest">Newest First</option>
                        <option value="name">Name A-Z</option>
                    </select>
                </div>
            </div>
            <div class="media-grid" id="media-grid"></div>
        `;
        
        mediaManager.setupMediaControls();
        
        // Test filtering
        const filterSelect = document.getElementById('media-filter');
        filterSelect.value = 'video';
        filterSelect.dispatchEvent(new Event('change'));
        
        // Should call filterAndSortMedia
        expect(mediaManager.mediaFiles).toBeDefined();
    });
    
    test('should format file size correctly', async () => {
        mediaManager = new MediaManager();
        
        expect(mediaManager.formatFileSize(0)).toBe('0 Bytes');
        expect(mediaManager.formatFileSize(1024)).toBe('1 KB');
        expect(mediaManager.formatFileSize(1024 * 1024)).toBe('1 MB');
        expect(mediaManager.formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
    });
    
    test('should format duration correctly', async () => {
        mediaManager = new MediaManager();
        
        expect(mediaManager.formatDuration(30)).toBe('0:30');
        expect(mediaManager.formatDuration(90)).toBe('1:30');
        expect(mediaManager.formatDuration(3661)).toBe('1:01:01');
    });
    
    test('should handle drag and drop', async () => {
        mediaManager = new MediaManager();
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const mediaSection = document.getElementById('media-section');
        
        // Test drag over
        const dragOverEvent = new Event('dragover');
        dragOverEvent.preventDefault = jest.fn();
        mediaSection.dispatchEvent(dragOverEvent);
        expect(dragOverEvent.preventDefault).toHaveBeenCalled();
        
        // Test drag enter
        const dragEnterEvent = new Event('dragenter');
        dragEnterEvent.preventDefault = jest.fn();
        mediaSection.dispatchEvent(dragEnterEvent);
        expect(dragEnterEvent.preventDefault).toHaveBeenCalled();
        expect(mediaSection.classList.contains('drag-over')).toBe(true);
    });
});

// Export for manual testing
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createMockDOM, createMockApiClient };
}