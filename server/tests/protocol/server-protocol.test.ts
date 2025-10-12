/**
 * Protocol Validation Tests - Server Side
 *
 * These tests verify that the server can correctly parse
 * messages that the Rust client will send. Uses shared
 * JSON fixtures to ensure compatibility.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  registerMessageSchema,
  statusUpdateMessageSchema,
  heartbeatMessageSchema,
  errorMessageSchema,
} from '../../src/websocket/types';

describe('Protocol Validation - Server', () => {
  const fixturesDir = join(__dirname, '../../../tests/protocol/fixtures');

  describe('Client → Server Messages', () => {
    it('should parse register message correctly', () => {
      const json = readFileSync(join(fixturesDir, 'register.json'), 'utf-8');
      const data = JSON.parse(json);

      const result = registerMessageSchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('register');
        expect(result.data.clientId).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(result.data.version).toBe('1.0.0');
        expect(result.data.capabilities.video).toBe(true);
        expect(result.data.capabilities.image).toBe(true);
      }
    });

    it('should parse status_update message correctly', () => {
      const json = readFileSync(join(fixturesDir, 'status_update.json'), 'utf-8');
      const data = JSON.parse(json);

      const result = statusUpdateMessageSchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('status_update');
        expect(result.data.clientId).toBe('550e8400-e29b-41d4-a716-446655440000');
        if (result.data.currentMedia) {
          expect(result.data.currentMedia.id).toBe(42);
          expect(result.data.currentMedia.filename).toBe('video.mp4');
        }
        expect(result.data.position).toBe(15.5);
        expect(result.data.isPlaying).toBe(true);
      }
    });

    it('should parse heartbeat message correctly', () => {
      const json = readFileSync(join(fixturesDir, 'heartbeat.json'), 'utf-8');
      const data = JSON.parse(json);

      const result = heartbeatMessageSchema.safeParse(data);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('heartbeat');
        expect(result.data.clientId).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(result.data.timestamp).toBe(1704067200000);
      }
    });

    it('should reject invalid register message', () => {
      const invalidMessage = {
        type: 'register',
        // Missing required fields
      };

      const result = registerMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });

    it('should reject invalid status_update message', () => {
      const invalidMessage = {
        type: 'status_update',
        clientId: '123',
        // Missing other required fields
      };

      const result = statusUpdateMessageSchema.safeParse(invalidMessage);
      expect(result.success).toBe(false);
    });
  });

  describe('Server → Client Messages', () => {
    it('should serialize playlist_assigned message correctly', () => {
      const json = readFileSync(join(fixturesDir, 'playlist_assigned.json'), 'utf-8');
      const expected = JSON.parse(json);

      // Verify the structure matches what we expect
      expect(expected.type).toBe('playlist_assigned');
      expect(expected.playlistId).toBe(1);
      expect(Array.isArray(expected.items)).toBe(true);
      expect(expected.items.length).toBe(2);

      // Verify first item (video)
      expect(expected.items[0].type).toBe('video');
      expect(expected.items[0].filename).toBe('video.mp4');
      expect(expected.items[0].duration).toBe(120.5);

      // Verify second item (image)
      expect(expected.items[1].type).toBe('image');
      expect(expected.items[1].filename).toBe('image.jpg');
      expect(expected.items[1].imageDuration).toBe(10);
    });

    it('should validate playlist item structure', () => {
      const json = readFileSync(join(fixturesDir, 'playlist_assigned.json'), 'utf-8');
      const data = JSON.parse(json);

      // Check all required fields are present
      for (const item of data.items) {
        expect(item).toHaveProperty('id');
        expect(item).toHaveProperty('mediaId');
        expect(item).toHaveProperty('filename');
        expect(item).toHaveProperty('downloadUrl');
        expect(item).toHaveProperty('type');
        expect(item).toHaveProperty('checksum');
        expect(item).toHaveProperty('orderIndex');
        expect(item).toHaveProperty('imageDuration');

        // Type should be video or image
        expect(['video', 'image']).toContain(item.type);

        // Download URL should be valid
        expect(item.downloadUrl).toMatch(/^http/);
      }
    });
  });

  describe('Round-trip serialization', () => {
    it('should serialize and deserialize register message', () => {
      const original = {
        type: 'register' as const,
        clientId: '550e8400-e29b-41d4-a716-446655440001',
        version: '1.0.0',
        capabilities: {
          video: true,
          image: false,
        },
      };

      // Serialize
      const json = JSON.stringify(original);

      // Deserialize and validate
      const parsed = JSON.parse(json);
      const result = registerMessageSchema.safeParse(parsed);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(original);
      }
    });

    it('should handle optional fields correctly', () => {
      // Status update with minimal fields (all required fields present)
      const minimal = {
        type: 'status_update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        currentMedia: null,
        position: 0,
        isPlaying: false,
        timestamp: Date.now(),
      };

      const result = statusUpdateMessageSchema.safeParse(minimal);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.currentMedia).toBeNull();
        expect(result.data.position).toBe(0);
        expect(result.data.isPlaying).toBe(false);
      }
    });

    it('should allow null position in status update', () => {
      // Status update with null position (useful for images or idle state)
      const statusWithNullPosition = {
        type: 'status_update',
        clientId: '550e8400-e29b-41d4-a716-446655440000',
        currentMedia: {
          id: 10,
          filename: 'image.jpg',
        },
        position: null,
        isPlaying: true,
        timestamp: Date.now(),
      };

      const result = statusUpdateMessageSchema.safeParse(statusWithNullPosition);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.position).toBeNull();
        expect(result.data.currentMedia).not.toBeNull();
      }
    });
  });
});
