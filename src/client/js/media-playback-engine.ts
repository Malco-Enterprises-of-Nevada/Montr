// Media Playback Engine
// Handles video and image playback with smooth transitions

interface MediaFile {
    id: string;
    filename: string;
    original_name: string;
    file_type: 'video' | 'image';
    mime_type: string;
    file_size: number;
    duration?: number;
    thumbnail_path?: string;
    created_at: Date;
}

interface PlaylistItem {
    id: string;
    playlist_id: string;
    media_file_id: string;
    order_index: number;
    display_duration?: number;
    media_file?: MediaFile | null;
}

interface Playlist {
    id: string;
    name: string;
    description?: string;
    items?: PlaylistItem[];
    created_at: Date;
    updated_at: Date;
}

interface PlaybackOptions {
    autoplay: boolean;
    loop: boolean;
    muted: boolean;
    defaultImageDuration: number; // seconds
    transitionDuration: number; // milliseconds
    preloadNext: boolean;
}

interface PlaybackState {
    isPlaying: boolean;
    currentIndex: number;
    currentItem?: PlaylistItem;
    playlist?: Playlist;
    playbackStartTime?: Date;
    totalPlaytime: number;
}

type MediaType = 'video' | 'image' | 'none';

class MediaPlaybackEngine {
    private videoPlayer: HTMLVideoElement;
    private imagePlayer: HTMLImageElement;
    private containerElement: HTMLElement;
    private options: PlaybackOptions;
    private state: PlaybackState;
    private currentMediaTimeout: NodeJS.Timeout | null = null;
    private transitionTimeout: NodeJS.Timeout | null = null;
    private preloadedMedia: Map<string, HTMLVideoElement | HTMLImageElement> = new Map();
    
    // Event callbacks
    private onMediaEndedCallback?: () => void;
    private onMediaErrorCallback?: (error: Error, item?: PlaylistItem) => void;
    private onPlaybackStateChangeCallback?: (state: PlaybackState) => void;
    private onTransitionStartCallback?: (fromType: MediaType, toType: MediaType) => void;
    private onTransitionCompleteCallback?: (mediaType: MediaType) => void;

    constructor(
        videoElement: HTMLVideoElement,
        imageElement: HTMLImageElement,
        container: HTMLElement,
        options: Partial<PlaybackOptions> = {}
    ) {
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

    private initializeEventHandlers(): void {
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

    public setPlaylist(playlist: Playlist | undefined): void {
        this.state.playlist = playlist;
        this.state.currentIndex = 0;
        this.state.totalPlaytime = 0;
        this.clearPreloadedMedia();
        
        if (playlist && playlist.items && playlist.items.length > 0) {
            this.preloadCurrentAndNext();
        }
        
        this.notifyStateChange();
    }

    public play(): void {
        if (!this.state.playlist || !this.state.playlist.items || this.state.playlist.items.length === 0) {
            console.warn('Cannot play: No playlist or empty playlist');
            return;
        }

        this.state.isPlaying = true;
        this.state.playbackStartTime = new Date();
        this.playCurrentItem();
        this.notifyStateChange();
    }

    public pause(): void {
        this.state.isPlaying = false;
        this.pauseCurrentMedia();
        this.notifyStateChange();
    }

    public stop(): void {
        this.state.isPlaying = false;
        this.state.currentIndex = 0;
        this.stopCurrentMedia();
        this.hideAllPlayers();
        this.clearTimeouts();
        this.notifyStateChange();
    }

    public next(): void {
        if (!this.state.playlist || !this.state.playlist.items) return;
        
        this.advanceToNext();
    }

    public previous(): void {
        if (!this.state.playlist || !this.state.playlist.items) return;
        
        this.state.currentIndex = this.state.currentIndex > 0 
            ? this.state.currentIndex - 1 
            : this.state.playlist.items.length - 1;
        
        if (this.state.isPlaying) {
            this.playCurrentItem();
        }
        this.notifyStateChange();
    }

    public jumpToItem(index: number): void {
        if (!this.state.playlist || !this.state.playlist.items) return;
        
        if (index >= 0 && index < this.state.playlist.items.length) {
            this.state.currentIndex = index;
            if (this.state.isPlaying) {
                this.playCurrentItem();
            }
            this.notifyStateChange();
        }
    }

    private playCurrentItem(): void {
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
        } else if (mediaFile.file_type === 'image') {
            const duration = currentItem.display_duration || mediaFile.duration || this.options.defaultImageDuration;
            this.playImage(mediaUrl, mediaFile, duration);
        }

        // Preload next item
        if (this.options.preloadNext) {
            this.preloadNext();
        }

        this.notifyStateChange();
    }

    private playVideo(url: string, mediaFile: MediaFile): void {
        // Check if we have a preloaded version
        const preloaded = this.preloadedMedia.get(mediaFile.id) as HTMLVideoElement;
        
        if (preloaded && preloaded.readyState >= 2) {
            // Use preloaded video
            this.transitionToVideo(preloaded);
        } else {
            // Load video normally
            this.videoPlayer.src = url;
            this.videoPlayer.load();
        }
    }

    private playImage(url: string, mediaFile: MediaFile, duration: number): void {
        // Check if we have a preloaded version
        const preloaded = this.preloadedMedia.get(mediaFile.id) as HTMLImageElement;
        
        if (preloaded && preloaded.complete) {
            // Use preloaded image
            this.transitionToImage(preloaded, duration);
        } else {
            // Load image normally
            this.imagePlayer.src = url;
            // Set timeout for when image loads
            this.imagePlayer.onload = () => {
                this.transitionToImage(this.imagePlayer, duration);
            };
        }
    }

    private transitionToVideo(videoElement: HTMLVideoElement): void {
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

    private transitionToImage(imageElement: HTMLImageElement, duration: number): void {
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

    private performTransition(callback: () => void): void {
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

    private getCurrentVisibleElement(): HTMLElement | null {
        if (this.videoPlayer.style.display === 'block') return this.videoPlayer;
        if (this.imagePlayer.style.display === 'block') return this.imagePlayer;
        return null;
    }

    private getCurrentVisibleMediaType(): MediaType {
        if (this.videoPlayer.style.display === 'block') return 'video';
        if (this.imagePlayer.style.display === 'block') return 'image';
        return 'none';
    }

    private hideAllPlayers(): void {
        this.videoPlayer.style.display = 'none';
        this.imagePlayer.style.display = 'none';
        
        // Pause video if playing
        if (!this.videoPlayer.paused) {
            this.videoPlayer.pause();
        }
        
        this.clearTimeouts();
    }

    private pauseCurrentMedia(): void {
        if (!this.videoPlayer.paused) {
            this.videoPlayer.pause();
        }
        // For images, we keep the timeout running but mark as paused
    }

    private stopCurrentMedia(): void {
        this.videoPlayer.pause();
        this.videoPlayer.currentTime = 0;
        this.clearTimeouts();
    }

    private clearTimeouts(): void {
        if (this.currentMediaTimeout) {
            clearTimeout(this.currentMediaTimeout);
            this.currentMediaTimeout = null;
        }
        if (this.transitionTimeout) {
            clearTimeout(this.transitionTimeout);
            this.transitionTimeout = null;
        }
    }

    private advanceToNext(): void {
        if (!this.state.playlist || !this.state.playlist.items) return;
        
        this.state.currentIndex++;
        
        // Loop back to beginning if at end and looping is enabled
        if (this.state.currentIndex >= this.state.playlist.items.length) {
            if (this.options.loop) {
                this.state.currentIndex = 0;
            } else {
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

    private handleMediaEnded(): void {
        console.log('Media ended, advancing to next item');
        this.updatePlaytime();
        
        if (this.onMediaEndedCallback) {
            this.onMediaEndedCallback();
        }
        
        this.advanceToNext();
    }

    private handleMediaError(event: Event, mediaType: 'video' | 'image'): void {
        console.error(`${mediaType} playback error:`, event);
        
        const error = new Error(`${mediaType} playback failed`);
        if (this.onMediaErrorCallback) {
            this.onMediaErrorCallback(error, this.state.currentItem);
        }
        
        // Skip to next item on error
        this.advanceToNext();
    }

    private handleVideoLoadStart(): void {
        console.log('Video loading started');
    }

    private handleVideoCanPlay(): void {
        console.log('Video can play');
        if (this.options.autoplay && this.state.isPlaying) {
            this.videoPlayer.play().catch(error => {
                console.error('Video play failed:', error);
                this.handleMediaError(new Event('play-failed'), 'video');
            });
        }
    }

    private handleVideoTimeUpdate(): void {
        // Update playtime tracking
        this.updatePlaytime();
    }

    private handleVideoMetadataLoaded(): void {
        console.log('Video metadata loaded, duration:', this.videoPlayer.duration);
    }

    private handleImageLoaded(): void {
        console.log('Image loaded successfully');
    }

    private updatePlaytime(): void {
        if (this.state.playbackStartTime) {
            const now = new Date();
            const sessionTime = now.getTime() - this.state.playbackStartTime.getTime();
            this.state.totalPlaytime += sessionTime;
            this.state.playbackStartTime = now;
        }
    }

    // Preloading functionality
    private preloadCurrentAndNext(): void {
        if (!this.state.playlist || !this.state.playlist.items) return;
        
        const currentItem = this.state.playlist.items[this.state.currentIndex];
        if (currentItem) {
            this.preloadItem(currentItem);
        }
        
        this.preloadNext();
    }

    private preloadNext(): void {
        if (!this.state.playlist || !this.state.playlist.items) return;
        
        const nextIndex = (this.state.currentIndex + 1) % this.state.playlist.items.length;
        const nextItem = this.state.playlist.items[nextIndex];
        
        if (nextItem) {
            this.preloadItem(nextItem);
        }
    }

    private preloadItem(item: PlaylistItem): void {
        if (!item.media_file || this.preloadedMedia.has(item.media_file.id)) return;
        
        const mediaFile = item.media_file;
        const mediaUrl = `/uploads/${mediaFile.file_type}s/${mediaFile.filename}`;
        
        if (mediaFile.file_type === 'video') {
            const video = document.createElement('video');
            video.src = mediaUrl;
            video.muted = true;
            video.preload = 'metadata';
            video.load();
            this.preloadedMedia.set(mediaFile.id, video);
        } else if (mediaFile.file_type === 'image') {
            const img = new Image();
            img.src = mediaUrl;
            this.preloadedMedia.set(mediaFile.id, img);
        }
    }

    private clearPreloadedMedia(): void {
        this.preloadedMedia.clear();
    }

    private notifyStateChange(): void {
        if (this.onPlaybackStateChangeCallback) {
            this.onPlaybackStateChangeCallback({ ...this.state });
        }
    }

    // Event handler setters
    public onMediaEnded(callback: () => void): void {
        this.onMediaEndedCallback = callback;
    }

    public onMediaError(callback: (error: Error, item?: PlaylistItem) => void): void {
        this.onMediaErrorCallback = callback;
    }

    public onPlaybackStateChange(callback: (state: PlaybackState) => void): void {
        this.onPlaybackStateChangeCallback = callback;
    }

    public onTransitionStart(callback: (fromType: MediaType, toType: MediaType) => void): void {
        this.onTransitionStartCallback = callback;
    }

    public onTransitionComplete(callback: (mediaType: MediaType) => void): void {
        this.onTransitionCompleteCallback = callback;
    }

    // Getters
    public getState(): PlaybackState {
        return { ...this.state };
    }

    public getCurrentItem(): PlaylistItem | undefined {
        return this.state.currentItem;
    }

    public isPlaying(): boolean {
        return this.state.isPlaying;
    }

    public getCurrentIndex(): number {
        return this.state.currentIndex;
    }

    public getPlaylist(): Playlist | undefined {
        return this.state.playlist;
    }

    public getTotalPlaytime(): number {
        this.updatePlaytime();
        return this.state.totalPlaytime;
    }

    // Configuration
    public updateOptions(newOptions: Partial<PlaybackOptions>): void {
        this.options = { ...this.options, ...newOptions };
        
        // Apply video options
        this.videoPlayer.muted = this.options.muted;
        this.videoPlayer.autoplay = this.options.autoplay;
    }

    public getOptions(): PlaybackOptions {
        return { ...this.options };
    }

    // Cleanup
    public destroy(): void {
        this.stop();
        this.clearPreloadedMedia();
        
        // Remove event listeners would go here if we added them dynamically
        // For now, the elements will be cleaned up when the DOM is destroyed
    }
}

export default MediaPlaybackEngine;
export type { PlaybackOptions, PlaybackState, MediaType, PlaylistItem, MediaFile, Playlist };