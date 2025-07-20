// Media Playback Engine
// Handles video and image playback with smooth transitions
class MediaPlaybackEngine {
    constructor(videoElement, imageElement, container, options = {}) {
        this.currentMediaTimeout = null;
        this.transitionTimeout = null;
        this.preloadedMedia = new Map();
        this.videoPlayer = videoElement;
        this.imagePlayer = imageElement;
        this.containerElement = container;
        this.options = {
            autoplay: true,
            loop: true,
            muted: true,
            defaultImageDuration: 5,
            transitionDuration: 500,
            preloadNext: true,
            ...options
        };
        this.state = {
            isPlaying: false,
            currentIndex: 0,
            totalPlaytime: 0
        };
        this.initializeEventHandlers();
    }
    initializeEventHandlers() {
        // Video player events
        this.videoPlayer.addEventListener('ended', () => this.handleMediaEnded());
        this.videoPlayer.addEventListener('error', (e) => this.handleMediaError(e, 'video'));
        this.videoPlayer.addEventListener('loadstart', () => this.handleVideoLoadStart());
        this.videoPlayer.addEventListener('canplay', () => this.handleVideoCanPlay());
        this.videoPlayer.addEventListener('timeupdate', () => this.handleVideoTimeUpdate());
        this.videoPlayer.addEventListener('loadedmetadata', () => this.handleVideoMetadataLoaded());
        // Image player events
        this.imagePlayer.addEventListener('error', (e) => this.handleMediaError(e, 'image'));
        this.imagePlayer.addEventListener('load', () => this.handleImageLoaded());
        // Set video properties
        this.videoPlayer.muted = this.options.muted;
        this.videoPlayer.autoplay = this.options.autoplay;
    }
    setPlaylist(playlist) {
        this.state.playlist = playlist;
        this.state.currentIndex = 0;
        this.state.totalPlaytime = 0;
        this.clearPreloadedMedia();
        if (playlist && playlist.items && playlist.items.length > 0) {
            this.preloadCurrentAndNext();
        }
        this.notifyStateChange();
    }
    play() {
        if (!this.state.playlist || !this.state.playlist.items || this.state.playlist.items.length === 0) {
            console.warn('Cannot play: No playlist or empty playlist');
            return;
        }
        this.state.isPlaying = true;
        this.state.playbackStartTime = new Date();
        this.playCurrentItem();
        this.notifyStateChange();
    }
    pause() {
        this.state.isPlaying = false;
        this.pauseCurrentMedia();
        this.notifyStateChange();
    }
    stop() {
        this.state.isPlaying = false;
        this.state.currentIndex = 0;
        this.stopCurrentMedia();
        this.hideAllPlayers();
        this.clearTimeouts();
        this.notifyStateChange();
    }
    next() {
        if (!this.state.playlist || !this.state.playlist.items)
            return;
        this.advanceToNext();
    }
    previous() {
        if (!this.state.playlist || !this.state.playlist.items)
            return;
        this.state.currentIndex = this.state.currentIndex > 0
            ? this.state.currentIndex - 1
            : this.state.playlist.items.length - 1;
        if (this.state.isPlaying) {
            this.playCurrentItem();
        }
        this.notifyStateChange();
    }
    jumpToItem(index) {
        if (!this.state.playlist || !this.state.playlist.items)
            return;
        if (index >= 0 && index < this.state.playlist.items.length) {
            this.state.currentIndex = index;
            if (this.state.isPlaying) {
                this.playCurrentItem();
            }
            this.notifyStateChange();
        }
    }
    playCurrentItem() {
        const playlist = this.state.playlist;
        if (!playlist || !playlist.items || playlist.items.length === 0) {
            return;
        }
        const currentItem = playlist.items[this.state.currentIndex];
        if (!currentItem || !currentItem.media_file) {
            console.warn('Current item has no media file, advancing to next');
            this.advanceToNext();
            return;
        }
        this.state.currentItem = currentItem;
        const mediaFile = currentItem.media_file;
        const mediaUrl = `/uploads/${mediaFile.file_type}s/${mediaFile.filename}`;
        console.log(`Playing item ${this.state.currentIndex + 1}/${playlist.items.length}:`, mediaFile.original_name);
        // Start transition
        const currentType = this.getCurrentVisibleMediaType();
        const nextType = mediaFile.file_type;
        if (this.onTransitionStartCallback) {
            this.onTransitionStartCallback(currentType, nextType);
        }
        if (mediaFile.file_type === 'video') {
            this.playVideo(mediaUrl, mediaFile);
        }
        else if (mediaFile.file_type === 'image') {
            const duration = currentItem.display_duration || mediaFile.duration || this.options.defaultImageDuration;
            this.playImage(mediaUrl, mediaFile, duration);
        }
        // Preload next item
        if (this.options.preloadNext) {
            this.preloadNext();
        }
        this.notifyStateChange();
    }
    playVideo(url, mediaFile) {
        // Check if we have a preloaded version
        const preloaded = this.preloadedMedia.get(mediaFile.id);
        if (preloaded && preloaded.readyState >= 2) {
            // Use preloaded video
            this.transitionToVideo(preloaded);
        }
        else {
            // Load video normally
            this.videoPlayer.src = url;
            this.videoPlayer.load();
        }
    }
    playImage(url, mediaFile, duration) {
        // Check if we have a preloaded version
        const preloaded = this.preloadedMedia.get(mediaFile.id);
        if (preloaded && preloaded.complete) {
            // Use preloaded image
            this.transitionToImage(preloaded, duration);
        }
        else {
            // Load image normally
            this.imagePlayer.src = url;
            // Set timeout for when image loads
            this.imagePlayer.onload = () => {
                this.transitionToImage(this.imagePlayer, duration);
            };
        }
    }
    transitionToVideo(videoElement) {
        this.performTransition(() => {
            // Copy preloaded video to main player if different
            if (videoElement !== this.videoPlayer) {
                this.videoPlayer.src = videoElement.src;
                this.videoPlayer.currentTime = videoElement.currentTime;
                this.videoPlayer.load();
            }
            this.hideAllPlayers();
            this.videoPlayer.style.display = 'block';
            this.videoPlayer.style.opacity = '1';
            if (this.onTransitionCompleteCallback) {
                this.onTransitionCompleteCallback('video');
            }
        });
    }
    transitionToImage(imageElement, duration) {
        this.performTransition(() => {
            // Copy preloaded image to main player if different
            if (imageElement !== this.imagePlayer) {
                this.imagePlayer.src = imageElement.src;
            }
            this.hideAllPlayers();
            this.imagePlayer.style.display = 'block';
            this.imagePlayer.style.opacity = '1';
            // Set timer for image duration
            this.currentMediaTimeout = setTimeout(() => {
                this.handleMediaEnded();
            }, duration * 1000);
            if (this.onTransitionCompleteCallback) {
                this.onTransitionCompleteCallback('image');
            }
        });
    }
    performTransition(callback) {
        // Fade out current media
        const currentVisible = this.getCurrentVisibleElement();
        if (currentVisible) {
            currentVisible.style.transition = `opacity ${this.options.transitionDuration}ms ease-in-out`;
            currentVisible.style.opacity = '0';
        }
        // Execute transition after fade out
        this.transitionTimeout = setTimeout(() => {
            callback();
            // Fade in new media
            const newVisible = this.getCurrentVisibleElement();
            if (newVisible) {
                newVisible.style.transition = `opacity ${this.options.transitionDuration}ms ease-in-out`;
                newVisible.style.opacity = '0';
                // Force reflow then fade in
                newVisible.offsetHeight;
                newVisible.style.opacity = '1';
            }
        }, currentVisible ? this.options.transitionDuration : 0);
    }
    getCurrentVisibleElement() {
        if (this.videoPlayer.style.display === 'block')
            return this.videoPlayer;
        if (this.imagePlayer.style.display === 'block')
            return this.imagePlayer;
        return null;
    }
    getCurrentVisibleMediaType() {
        if (this.videoPlayer.style.display === 'block')
            return 'video';
        if (this.imagePlayer.style.display === 'block')
            return 'image';
        return 'none';
    }
    hideAllPlayers() {
        this.videoPlayer.style.display = 'none';
        this.imagePlayer.style.display = 'none';
        // Pause video if playing
        if (!this.videoPlayer.paused) {
            this.videoPlayer.pause();
        }
        this.clearTimeouts();
    }
    pauseCurrentMedia() {
        if (!this.videoPlayer.paused) {
            this.videoPlayer.pause();
        }
        // For images, we keep the timeout running but mark as paused
    }
    stopCurrentMedia() {
        this.videoPlayer.pause();
        this.videoPlayer.currentTime = 0;
        this.clearTimeouts();
    }
    clearTimeouts() {
        if (this.currentMediaTimeout) {
            clearTimeout(this.currentMediaTimeout);
            this.currentMediaTimeout = null;
        }
        if (this.transitionTimeout) {
            clearTimeout(this.transitionTimeout);
            this.transitionTimeout = null;
        }
    }
    advanceToNext() {
        if (!this.state.playlist || !this.state.playlist.items)
            return;
        this.state.currentIndex++;
        // Loop back to beginning if at end and looping is enabled
        if (this.state.currentIndex >= this.state.playlist.items.length) {
            if (this.options.loop) {
                this.state.currentIndex = 0;
            }
            else {
                this.stop();
                return;
            }
        }
        if (this.state.isPlaying) {
            // Small delay for smooth transition
            setTimeout(() => {
                this.playCurrentItem();
            }, 100);
        }
    }
    handleMediaEnded() {
        console.log('Media ended, advancing to next item');
        this.updatePlaytime();
        if (this.onMediaEndedCallback) {
            this.onMediaEndedCallback();
        }
        this.advanceToNext();
    }
    handleMediaError(event, mediaType) {
        console.error(`${mediaType} playback error:`, event);
        const error = new Error(`${mediaType} playback failed`);
        if (this.onMediaErrorCallback) {
            this.onMediaErrorCallback(error, this.state.currentItem);
        }
        // Skip to next item on error
        this.advanceToNext();
    }
    handleVideoLoadStart() {
        console.log('Video loading started');
    }
    handleVideoCanPlay() {
        console.log('Video can play');
        if (this.options.autoplay && this.state.isPlaying) {
            this.videoPlayer.play().catch(error => {
                console.error('Video play failed:', error);
                this.handleMediaError(new Event('play-failed'), 'video');
            });
        }
    }
    handleVideoTimeUpdate() {
        // Update playtime tracking
        this.updatePlaytime();
    }
    handleVideoMetadataLoaded() {
        console.log('Video metadata loaded, duration:', this.videoPlayer.duration);
    }
    handleImageLoaded() {
        console.log('Image loaded successfully');
    }
    updatePlaytime() {
        if (this.state.playbackStartTime) {
            const now = new Date();
            const sessionTime = now.getTime() - this.state.playbackStartTime.getTime();
            this.state.totalPlaytime += sessionTime;
            this.state.playbackStartTime = now;
        }
    }
    // Preloading functionality
    preloadCurrentAndNext() {
        if (!this.state.playlist || !this.state.playlist.items)
            return;
        const currentItem = this.state.playlist.items[this.state.currentIndex];
        if (currentItem) {
            this.preloadItem(currentItem);
        }
        this.preloadNext();
    }
    preloadNext() {
        if (!this.state.playlist || !this.state.playlist.items)
            return;
        const nextIndex = (this.state.currentIndex + 1) % this.state.playlist.items.length;
        const nextItem = this.state.playlist.items[nextIndex];
        if (nextItem) {
            this.preloadItem(nextItem);
        }
    }
    preloadItem(item) {
        if (!item.media_file || this.preloadedMedia.has(item.media_file.id))
            return;
        const mediaFile = item.media_file;
        const mediaUrl = `/uploads/${mediaFile.file_type}s/${mediaFile.filename}`;
        if (mediaFile.file_type === 'video') {
            const video = document.createElement('video');
            video.src = mediaUrl;
            video.muted = true;
            video.preload = 'metadata';
            video.load();
            this.preloadedMedia.set(mediaFile.id, video);
        }
        else if (mediaFile.file_type === 'image') {
            const img = new Image();
            img.src = mediaUrl;
            this.preloadedMedia.set(mediaFile.id, img);
        }
    }
    clearPreloadedMedia() {
        this.preloadedMedia.clear();
    }
    notifyStateChange() {
        if (this.onPlaybackStateChangeCallback) {
            this.onPlaybackStateChangeCallback({ ...this.state });
        }
    }
    // Event handler setters
    onMediaEnded(callback) {
        this.onMediaEndedCallback = callback;
    }
    onMediaError(callback) {
        this.onMediaErrorCallback = callback;
    }
    onPlaybackStateChange(callback) {
        this.onPlaybackStateChangeCallback = callback;
    }
    onTransitionStart(callback) {
        this.onTransitionStartCallback = callback;
    }
    onTransitionComplete(callback) {
        this.onTransitionCompleteCallback = callback;
    }
    // Getters
    getState() {
        return { ...this.state };
    }
    getCurrentItem() {
        return this.state.currentItem;
    }
    isPlaying() {
        return this.state.isPlaying;
    }
    getCurrentIndex() {
        return this.state.currentIndex;
    }
    getPlaylist() {
        return this.state.playlist;
    }
    getTotalPlaytime() {
        this.updatePlaytime();
        return this.state.totalPlaytime;
    }
    // Configuration
    updateOptions(newOptions) {
        this.options = { ...this.options, ...newOptions };
        // Apply video options
        this.videoPlayer.muted = this.options.muted;
        this.videoPlayer.autoplay = this.options.autoplay;
    }
    getOptions() {
        return { ...this.options };
    }
    // Cleanup
    destroy() {
        this.stop();
        this.clearPreloadedMedia();
        // Remove event listeners would go here if we added them dynamically
        // For now, the elements will be cleaned up when the DOM is destroyed
    }
}
export default MediaPlaybackEngine;
//# sourceMappingURL=media-playback-engine.js.map