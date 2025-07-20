/**
 * API Client for Media Playlist Management
 * Handles all REST API communication with the server
 */
class ApiClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this.defaultHeaders = {
            'Content-Type': 'application/json'
        };
    }

    /**
     * Make HTTP request with error handling
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const config = {
            headers: { ...this.defaultHeaders, ...options.headers },
            ...options
        };

        try {
            const response = await fetch(url, config);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error?.message || `HTTP ${response.status}: ${response.statusText}`);
            }

            return data;
        } catch (error) {
            console.error(`API request failed: ${endpoint}`, error);
            throw error;
        }
    }

    // Playlist API methods
    async getPlaylists(includeItems = false) {
        const params = includeItems ? '?includeItems=true' : '';
        return this.request(`/api/playlists${params}`);
    }

    async getPlaylist(id, includeItems = true) {
        const params = includeItems ? '?includeItems=true' : '';
        return this.request(`/api/playlists/${id}${params}`);
    }

    async createPlaylist(data) {
        return this.request('/api/playlists', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async updatePlaylist(id, data) {
        return this.request(`/api/playlists/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async deletePlaylist(id) {
        return this.request(`/api/playlists/${id}`, {
            method: 'DELETE'
        });
    }

    async activatePlaylist(id) {
        return this.request(`/api/playlists/${id}/activate`, {
            method: 'POST'
        });
    }

    async getActivePlaylist() {
        return this.request('/api/playlists/active/current');
    }

    async getConnectedClients() {
        return this.request('/api/playlists/clients');
    }

    // Playlist Items API methods
    async addPlaylistItem(playlistId, data) {
        return this.request(`/api/playlists/${playlistId}/items`, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    }

    async updatePlaylistItem(playlistId, itemId, data) {
        return this.request(`/api/playlists/${playlistId}/items/${itemId}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    }

    async deletePlaylistItem(playlistId, itemId) {
        return this.request(`/api/playlists/${playlistId}/items/${itemId}`, {
            method: 'DELETE'
        });
    }

    // Media API methods
    async getMediaFiles(fileType = null) {
        const params = fileType ? `?fileType=${fileType}` : '';
        return this.request(`/api/media${params}`);
    }

    async getMediaFile(id) {
        return this.request(`/api/media/${id}/info`);
    }

    async uploadMediaFile(file, onProgress = null) {
        const formData = new FormData();
        formData.append('media', file);

        const config = {
            method: 'POST',
            body: formData,
            headers: {} // Let browser set Content-Type for FormData
        };

        // Add progress tracking if callback provided
        if (onProgress && typeof onProgress === 'function') {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                
                xhr.upload.addEventListener('progress', (event) => {
                    if (event.lengthComputable) {
                        const percentComplete = (event.loaded / event.total) * 100;
                        onProgress(percentComplete);
                    }
                });

                xhr.addEventListener('load', () => {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (xhr.status >= 200 && xhr.status < 300) {
                            resolve(data);
                        } else {
                            reject(new Error(data.error?.message || `HTTP ${xhr.status}`));
                        }
                    } catch (error) {
                        reject(new Error('Invalid response format'));
                    }
                });

                xhr.addEventListener('error', () => {
                    reject(new Error('Upload failed'));
                });

                xhr.open('POST', `${this.baseUrl}/api/media/upload`);
                xhr.send(formData);
            });
        }

        // Fallback to fetch for simple uploads
        return this.request('/api/media/upload', config);
    }

    async uploadMultipleMediaFiles(files, onProgress = null) {
        const formData = new FormData();
        files.forEach(file => {
            formData.append('media', file);
        });

        const config = {
            method: 'POST',
            body: formData,
            headers: {} // Let browser set Content-Type for FormData
        };

        return this.request('/api/media/upload/multiple', config);
    }

    async deleteMediaFile(id) {
        return this.request(`/api/media/${id}`, {
            method: 'DELETE'
        });
    }

    async getMediaStats() {
        return this.request('/api/media/stats/summary');
    }

    // Utility methods
    getMediaUrl(mediaFile) {
        return `${this.baseUrl}/api/media/${mediaFile.id}`;
    }

    getThumbnailUrl(mediaFile) {
        if (!mediaFile.thumbnail_path) {
            return null;
        }
        return `${this.baseUrl}/api/media/${mediaFile.id}/thumbnail`;
    }

    // Error handling utilities
    handleApiError(error, context = '') {
        console.error(`API Error${context ? ` (${context})` : ''}:`, error);
        
        // Show user-friendly error message
        const message = error.message || 'An unexpected error occurred';
        this.showErrorToast(message);
        
        return {
            success: false,
            error: message
        };
    }

    showErrorToast(message) {
        const errorToast = document.getElementById('error-toast');
        const errorMessage = document.getElementById('error-message');
        
        if (errorToast && errorMessage) {
            errorMessage.textContent = message;
            errorToast.classList.remove('hidden');
            
            // Auto-hide after 5 seconds
            setTimeout(() => {
                errorToast.classList.add('hidden');
            }, 5000);
        }
    }

    showSuccessToast(message) {
        const successToast = document.getElementById('success-toast');
        const successMessage = document.getElementById('success-message');
        
        if (successToast && successMessage) {
            successMessage.textContent = message;
            successToast.classList.remove('hidden');
            
            // Auto-hide after 3 seconds
            setTimeout(() => {
                successToast.classList.add('hidden');
            }, 3000);
        }
    }

    showLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.remove('hidden');
        }
    }

    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            overlay.classList.add('hidden');
        }
    }
}

// Create global API client instance
window.apiClient = new ApiClient();