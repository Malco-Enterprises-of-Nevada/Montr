/**
 * Tests for WebSocket message types and validation
 */

import {
  parseClientMessage,
  isClientMessage,
  registerMessageSchema,
  statusUpdateMessageSchema,
  heartbeatMessageSchema,
  errorMessageSchema,
  RegisterMessage,
  StatusUpdateMessage,
  HeartbeatMessage,
  ErrorMessage,
} from '../types';

describe('WebSocket Message Types', () => {
  describe('registerMessageSchema', () => {
    it('should validate a valid register message', () => {
      const message: RegisterMessage = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(message);
      }
    });

    it('should reject invalid UUID', () => {
      const message = {
        type: 'register',
        clientId: 'not-a-uuid',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });

    it('should reject missing capabilities', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });

    it('should reject empty version', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '',
        capabilities: {
          video: true,
          image: true,
        },
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });

    it('should validate a register message with name', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
        name: 'Mac-Display-1',
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate a register message without name', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject empty name string', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
        name: '',
      };

      const result = registerMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('statusUpdateMessageSchema', () => {
    it('should validate a valid status update message', () => {
      const message: StatusUpdateMessage = {
        type: 'status_update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        currentMedia: {
          id: 1,
          filename: 'video.mp4',
        },
        position: 42.5,
        isPlaying: true,
        timestamp: Date.now(),
      };

      const result = statusUpdateMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(message);
      }
    });

    it('should validate status update with null currentMedia', () => {
      const message: StatusUpdateMessage = {
        type: 'status_update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        currentMedia: null,
        position: 0,
        isPlaying: false,
        timestamp: Date.now(),
      };

      const result = statusUpdateMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should reject negative position', () => {
      const message = {
        type: 'status_update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        currentMedia: null,
        position: -5,
        isPlaying: false,
        timestamp: Date.now(),
      };

      const result = statusUpdateMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('heartbeatMessageSchema', () => {
    it('should validate a valid heartbeat message', () => {
      const message: HeartbeatMessage = {
        type: 'heartbeat',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        timestamp: Date.now(),
      };

      const result = heartbeatMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(message);
      }
    });

    it('should reject invalid UUID', () => {
      const message = {
        type: 'heartbeat',
        clientId: 'invalid-uuid',
        timestamp: Date.now(),
      };

      const result = heartbeatMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('errorMessageSchema', () => {
    it('should validate a valid error message', () => {
      const message: ErrorMessage = {
        type: 'error',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        error: 'Playback failed',
        context: {
          mediaId: 1,
          reason: 'codec not supported',
        },
      };

      const result = errorMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(message);
      }
    });

    it('should validate error message without context', () => {
      const message: ErrorMessage = {
        type: 'error',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        error: 'Unknown error',
      };

      const result = errorMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
    });

    it('should validate error message with optional timestamp', () => {
      const message = {
        type: 'error',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        error: 'Playback failed',
        context: { mediaId: 1 },
        timestamp: 1704067200000,
      };

      const result = errorMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timestamp).toBe(1704067200000);
      }
    });

    it('should validate error message with source and severity', () => {
      const message = {
        type: 'error',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        error: 'Preload timed out',
        source: 'preload',
        severity: 'warn' as const,
      };

      const result = errorMessageSchema.safeParse(message);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.source).toBe('preload');
        expect(result.data.severity).toBe('warn');
      }
    });

    it('should reject an unknown severity value', () => {
      const message = {
        type: 'error',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        error: 'Bad severity',
        severity: 'critical',
      };

      const result = errorMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });

    it('should reject empty error message', () => {
      const message = {
        type: 'error',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        error: '',
      };

      const result = errorMessageSchema.safeParse(message);
      expect(result.success).toBe(false);
    });
  });

  describe('parseClientMessage', () => {
    it('should parse valid register message', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
      };

      const parsed = parseClientMessage(message);
      expect(parsed.type).toBe('register');
      expect(parsed.clientId).toBe(message.clientId);
    });

    it('should throw on invalid message', () => {
      const message = {
        type: 'invalid',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
      };

      expect(() => parseClientMessage(message)).toThrow();
    });
  });

  describe('isClientMessage', () => {
    it('should return true for valid register message', () => {
      const message = {
        type: 'register',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: true,
        },
      };

      expect(isClientMessage(message)).toBe(true);
    });

    it('should return false for invalid message', () => {
      const message = {
        type: 'unknown',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
      };

      expect(isClientMessage(message)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isClientMessage('not an object')).toBe(false);
      expect(isClientMessage(null)).toBe(false);
      expect(isClientMessage(undefined)).toBe(false);
      expect(isClientMessage(123)).toBe(false);
    });
  });
});
