// Client-side Error Handler
// Provides comprehensive error handling and recovery mechanisms

export enum ErrorType {
  NETWORK = 'NETWORK_ERROR',
  WEBSOCKET = 'WEBSOCKET_ERROR',
  MEDIA_PLAYBACK = 'MEDIA_PLAYBACK_ERROR',
  PLAYLIST_SYNC = 'PLAYLIST_SYNC_ERROR',
  STORAGE = 'STORAGE_ERROR',
  VALIDATION = 'VALIDATION_ERROR',
  UNKNOWN = 'UNKNOWN_ERROR'
}

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export interface ClientError {
  type: ErrorType;
  severity: ErrorSeverity;
  message: string;
  details?: any;
  timestamp: Date;
  context?: Record<string, any>;
  recoverable: boolean;
  retryable: boolean;
}

export interface ErrorRecoveryStrategy {
  type: ErrorType;
  maxRetries: number;
  retryDelay: number;
  backoffMultiplier: number;
  maxRetryDelay: number;
  recoveryAction: (error: ClientError) => Promise<boolean>;
}

export interface ErrorReportingConfig {
  enabled: boolean;
  endpoint?: string;
  batchSize: number;
  flushInterval: number;
  maxStoredErrors: number;
}

class ClientErrorHandler {
  private errorQueue: ClientError[] = [];
  private retryAttempts: Map<string, number> = new Map();
  private recoveryStrategies: Map<ErrorType, ErrorRecoveryStrategy> = new Map();
  private reportingConfig: ErrorReportingConfig;
  private reportingTimer: NodeJS.Timeout | null = null;
  private isOnline: boolean = navigator.onLine;

  // DOM elements for error display
  private errorToast: HTMLElement | null = null;
  private errorMessage: HTMLElement | null = null;
  private errorDetails: HTMLElement | null = null;
  private errorDismiss: HTMLElement | null = null;

  constructor(config: Partial<ErrorReportingConfig> = {}) {
    this.reportingConfig = {
      enabled: true,
      batchSize: 10,
      flushInterval: 30000, // 30 seconds
      maxStoredErrors: 100,
      ...config
    };

    this.initializeDOM();
    this.setupRecoveryStrategies();
    this.setupNetworkMonitoring();
    this.startErrorReporting();
  }

  private initializeDOM(): void {
    // Create error toast if it doesn't exist
    this.errorToast = document.getElementById('error-toast');
    if (!this.errorToast) {
      this.createErrorToast();
    }

    this.errorMessage = document.getElementById('error-message');
    this.errorDetails = document.getElementById('error-details');
    this.errorDismiss = document.getElementById('error-dismiss');

    // Set up dismiss handler
    if (this.errorDismiss) {
      this.errorDismiss.addEventListener('click', () => {
        this.hideErrorToast();
      });
    }
  }

  private createErrorToast(): void {
    const toast = document.createElement('div');
    toast.id = 'error-toast';
    toast.className = 'error-toast hidden';
    toast.innerHTML = `
      <div class="error-content">
        <div class="error-icon">⚠️</div>
        <div class="error-text">
          <div id="error-message" class="error-message"></div>
          <div id="error-details" class="error-details"></div>
        </div>
        <button id="error-dismiss" class="error-dismiss">×</button>
      </div>
    `;
    
    document.body.appendChild(toast);
    this.errorToast = toast;
    this.errorMessage = document.getElementById('error-message');
    this.errorDetails = document.getElementById('error-details');
    this.errorDismiss = document.getElementById('error-dismiss');

    // Set up dismiss handler
    if (this.errorDismiss) {
      this.errorDismiss.addEventListener('click', () => {
        this.hideErrorToast();
      });
    }
  }

  private setupRecoveryStrategies(): void {
    // Network error recovery
    this.recoveryStrategies.set(ErrorType.NETWORK, {
      type: ErrorType.NETWORK,
      maxRetries: 5,
      retryDelay: 2000,
      backoffMultiplier: 2,
      maxRetryDelay: 30000,
      recoveryAction: async (error: ClientError) => {
        // Wait for network to come back online
        if (!this.isOnline) {
          return false;
        }
        
        // Try to reconnect or retry the failed operation
        return true;
      }
    });

    // WebSocket error recovery
    this.recoveryStrategies.set(ErrorType.WEBSOCKET, {
      type: ErrorType.WEBSOCKET,
      maxRetries: 10,
      retryDelay: 1000,
      backoffMultiplier: 1.5,
      maxRetryDelay: 30000,
      recoveryAction: async (error: ClientError) => {
        // Trigger WebSocket reconnection
        const event = new CustomEvent('websocket-reconnect-requested');
        window.dispatchEvent(event);
        return true;
      }
    });

    // Media playback error recovery
    this.recoveryStrategies.set(ErrorType.MEDIA_PLAYBACK, {
      type: ErrorType.MEDIA_PLAYBACK,
      maxRetries: 3,
      retryDelay: 1000,
      backoffMultiplier: 2,
      maxRetryDelay: 10000,
      recoveryAction: async (error: ClientError) => {
        // Skip to next media item
        const event = new CustomEvent('media-skip-requested', { 
          detail: { reason: 'playback-error' } 
        });
        window.dispatchEvent(event);
        return true;
      }
    });

    // Playlist sync error recovery
    this.recoveryStrategies.set(ErrorType.PLAYLIST_SYNC, {
      type: ErrorType.PLAYLIST_SYNC,
      maxRetries: 5,
      retryDelay: 5000,
      backoffMultiplier: 1.5,
      maxRetryDelay: 60000,
      recoveryAction: async (error: ClientError) => {
        // Use cached playlist if available
        const event = new CustomEvent('playlist-cache-fallback-requested');
        window.dispatchEvent(event);
        return true;
      }
    });

    // Storage error recovery
    this.recoveryStrategies.set(ErrorType.STORAGE, {
      type: ErrorType.STORAGE,
      maxRetries: 3,
      retryDelay: 1000,
      backoffMultiplier: 2,
      maxRetryDelay: 5000,
      recoveryAction: async (error: ClientError) => {
        // Clear storage and retry
        try {
          localStorage.clear();
          return true;
        } catch {
          return false;
        }
      }
    });
  }

  private setupNetworkMonitoring(): void {
    window.addEventListener('online', () => {
      this.isOnline = true;
      console.log('Network connection restored');
      this.showSuccessToast('Connection restored');
      
      // Retry failed network operations
      this.retryFailedOperations(ErrorType.NETWORK);
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      console.log('Network connection lost');
      this.handleError({
        type: ErrorType.NETWORK,
        severity: ErrorSeverity.HIGH,
        message: 'Network connection lost. Using cached content.',
        timestamp: new Date(),
        recoverable: true,
        retryable: true,
        context: { online: false }
      });
    });
  }

  private startErrorReporting(): void {
    if (!this.reportingConfig.enabled) return;

    this.reportingTimer = setInterval(() => {
      this.flushErrorQueue();
    }, this.reportingConfig.flushInterval);
  }

  public handleError(error: ClientError): void {
    // Add to error queue
    this.errorQueue.push(error);
    
    // Limit queue size
    if (this.errorQueue.length > this.reportingConfig.maxStoredErrors) {
      this.errorQueue.shift();
    }

    // Log error
    console.error('Client Error:', error);

    // Show user notification based on severity
    this.showErrorNotification(error);

    // Attempt recovery if error is recoverable
    if (error.recoverable) {
      this.attemptRecovery(error);
    }
  }

  private showErrorNotification(error: ClientError): void {
    const userFriendlyMessage = this.getUserFriendlyMessage(error);
    
    switch (error.severity) {
      case ErrorSeverity.CRITICAL:
      case ErrorSeverity.HIGH:
        this.showErrorToast(userFriendlyMessage, error);
        break;
      case ErrorSeverity.MEDIUM:
        this.showWarningToast(userFriendlyMessage);
        break;
      case ErrorSeverity.LOW:
        // Only log, don't show to user
        break;
    }
  }

  private getUserFriendlyMessage(error: ClientError): string {
    const friendlyMessages: Record<ErrorType, string> = {
      [ErrorType.NETWORK]: 'Connection issues detected. Trying to reconnect...',
      [ErrorType.WEBSOCKET]: 'Real-time connection lost. Reconnecting...',
      [ErrorType.MEDIA_PLAYBACK]: 'Media playback error. Skipping to next item...',
      [ErrorType.PLAYLIST_SYNC]: 'Playlist sync failed. Using cached content...',
      [ErrorType.STORAGE]: 'Storage error. Some features may not work properly.',
      [ErrorType.VALIDATION]: 'Invalid data received. Please refresh the page.',
      [ErrorType.UNKNOWN]: 'An unexpected error occurred.'
    };

    return friendlyMessages[error.type] || error.message;
  }

  private async attemptRecovery(error: ClientError): Promise<void> {
    const strategy = this.recoveryStrategies.get(error.type);
    if (!strategy) return;

    const errorKey = `${error.type}_${error.timestamp.getTime()}`;
    const currentAttempts = this.retryAttempts.get(errorKey) || 0;

    if (currentAttempts >= strategy.maxRetries) {
      console.error(`Max recovery attempts reached for error: ${error.type}`);
      return;
    }

    // Calculate retry delay with exponential backoff
    const delay = Math.min(
      strategy.retryDelay * Math.pow(strategy.backoffMultiplier, currentAttempts),
      strategy.maxRetryDelay
    );

    setTimeout(async () => {
      try {
        const recovered = await strategy.recoveryAction(error);
        
        if (recovered) {
          console.log(`Successfully recovered from error: ${error.type}`);
          this.retryAttempts.delete(errorKey);
          this.showSuccessToast('Issue resolved');
        } else {
          this.retryAttempts.set(errorKey, currentAttempts + 1);
          this.attemptRecovery(error);
        }
      } catch (recoveryError) {
        console.error('Recovery attempt failed:', recoveryError);
        this.retryAttempts.set(errorKey, currentAttempts + 1);
        this.attemptRecovery(error);
      }
    }, delay);
  }

  private async retryFailedOperations(errorType: ErrorType): Promise<void> {
    // Find all errors of the specified type that are retryable
    const retryableErrors = this.errorQueue.filter(
      error => error.type === errorType && error.retryable
    );

    for (const error of retryableErrors) {
      await this.attemptRecovery(error);
    }
  }

  private showErrorToast(message: string, error?: ClientError): void {
    if (!this.errorToast || !this.errorMessage) return;

    this.errorMessage.textContent = message;
    
    if (this.errorDetails && error?.details) {
      this.errorDetails.textContent = JSON.stringify(error.details, null, 2);
      this.errorDetails.style.display = 'block';
    } else if (this.errorDetails) {
      this.errorDetails.style.display = 'none';
    }

    this.errorToast.className = 'error-toast error-toast-error';
    
    // Auto-hide after 10 seconds for errors
    setTimeout(() => {
      this.hideErrorToast();
    }, 10000);
  }

  private showWarningToast(message: string): void {
    if (!this.errorToast || !this.errorMessage) return;

    this.errorMessage.textContent = message;
    
    if (this.errorDetails) {
      this.errorDetails.style.display = 'none';
    }

    this.errorToast.className = 'error-toast error-toast-warning';
    
    // Auto-hide after 5 seconds for warnings
    setTimeout(() => {
      this.hideErrorToast();
    }, 5000);
  }

  private showSuccessToast(message: string): void {
    if (!this.errorToast || !this.errorMessage) return;

    this.errorMessage.textContent = message;
    
    if (this.errorDetails) {
      this.errorDetails.style.display = 'none';
    }

    this.errorToast.className = 'error-toast error-toast-success';
    
    // Auto-hide after 3 seconds for success
    setTimeout(() => {
      this.hideErrorToast();
    }, 3000);
  }

  private hideErrorToast(): void {
    if (this.errorToast) {
      this.errorToast.className = 'error-toast hidden';
    }
  }

  private async flushErrorQueue(): Promise<void> {
    if (!this.reportingConfig.enabled || !this.reportingConfig.endpoint) return;
    if (this.errorQueue.length === 0) return;

    const errorsToSend = this.errorQueue.splice(0, this.reportingConfig.batchSize);
    
    try {
      await fetch(this.reportingConfig.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          errors: errorsToSend,
          clientInfo: {
            userAgent: navigator.userAgent,
            timestamp: new Date(),
            url: window.location.href
          }
        })
      });
    } catch (error) {
      // Put errors back in queue if reporting fails
      this.errorQueue.unshift(...errorsToSend);
      console.error('Failed to report errors:', error);
    }
  }

  // Public methods for creating specific error types
  public createNetworkError(message: string, details?: any): ClientError {
    return {
      type: ErrorType.NETWORK,
      severity: ErrorSeverity.HIGH,
      message,
      details,
      timestamp: new Date(),
      recoverable: true,
      retryable: true,
      context: { online: this.isOnline }
    };
  }

  public createWebSocketError(message: string, details?: any): ClientError {
    return {
      type: ErrorType.WEBSOCKET,
      severity: ErrorSeverity.HIGH,
      message,
      details,
      timestamp: new Date(),
      recoverable: true,
      retryable: true
    };
  }

  public createMediaPlaybackError(message: string, details?: any): ClientError {
    return {
      type: ErrorType.MEDIA_PLAYBACK,
      severity: ErrorSeverity.MEDIUM,
      message,
      details,
      timestamp: new Date(),
      recoverable: true,
      retryable: true
    };
  }

  public createPlaylistSyncError(message: string, details?: any): ClientError {
    return {
      type: ErrorType.PLAYLIST_SYNC,
      severity: ErrorSeverity.MEDIUM,
      message,
      details,
      timestamp: new Date(),
      recoverable: true,
      retryable: true
    };
  }

  public createStorageError(message: string, details?: any): ClientError {
    return {
      type: ErrorType.STORAGE,
      severity: ErrorSeverity.MEDIUM,
      message,
      details,
      timestamp: new Date(),
      recoverable: true,
      retryable: true
    };
  }

  public getErrorStats(): { total: number; byType: Record<ErrorType, number>; bySeverity: Record<ErrorSeverity, number> } {
    const stats = {
      total: this.errorQueue.length,
      byType: {} as Record<ErrorType, number>,
      bySeverity: {} as Record<ErrorSeverity, number>
    };

    for (const error of this.errorQueue) {
      stats.byType[error.type] = (stats.byType[error.type] || 0) + 1;
      stats.bySeverity[error.severity] = (stats.bySeverity[error.severity] || 0) + 1;
    }

    return stats;
  }

  public clearErrorQueue(): void {
    this.errorQueue = [];
    this.retryAttempts.clear();
  }

  public shutdown(): void {
    if (this.reportingTimer) {
      clearInterval(this.reportingTimer);
      this.reportingTimer = null;
    }
    
    // Flush remaining errors
    this.flushErrorQueue();
  }
}

export default ClientErrorHandler;