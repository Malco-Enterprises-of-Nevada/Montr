import { Server as HTTPServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { initializeWebSocket, getWebSocketManager, WebSocketManager } from '../index';
import { initializeDatabase } from '../../database';
import { PlaylistModel, SystemStateModel } from '../../models';

describe('WebSocket Server Basic Tests', () => {
  let httpServer: HTTPServer;
  let wsManager: WebSocketManager;
  let clientSocket: ClientSocket;
  let serverPort: number;

  beforeAll(async () => {
    // Initialize test database
    await initializeDatabase(':memory:');
    
    // Create HTTP server
    const app = express();
    httpServer = new HTTPServer(app);
    
    // Initialize WebSocket server
    wsManager = initializeWebSocket(httpServer);
    
    // Start server on random port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        serverPort = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
    
    if (wsManager) {
      wsManager.shutdown();
    }
    
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  });

  afterEach(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for cleanup
    }
  });

  test('should handle client connection', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      expect(clientSocket.connected).toBe(true);
      expect(wsManager.getClientCount()).toBe(1);
      done();
    });
  });

  test('should handle heartbeat', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      clientSocket.emit('heartbeat');
    });
    
    clientSocket.on('heartbeat-response', () => {
      expect(wsManager.getClientCount()).toBe(1);
      done();
    });
  });

  test('should broadcast playlist activation', async () => {
    // Create a test playlist
    const playlist = await PlaylistModel.create({
      name: 'Test Broadcast Playlist',
      description: 'Test Description'
    });
    
    return new Promise<void>((resolve) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('connect', async () => {
        // Broadcast playlist activation
        await wsManager.broadcastPlaylistActivated(playlist.id);
      });
      
      clientSocket.on('playlist-activated', (receivedPlaylist: any) => {
        expect(receivedPlaylist).toBeTruthy();
        expect(receivedPlaylist.id).toBe(playlist.id);
        expect(receivedPlaylist.name).toBe('Test Broadcast Playlist');
        resolve();
      });
    });
  });

  test('should send active playlist to new client', async () => {
    // Create and activate a playlist
    const playlist = await PlaylistModel.create({
      name: 'Active Playlist Test',
      description: 'Test Description'
    });
    
    await SystemStateModel.setActivePlaylistId(playlist.id);
    
    return new Promise<void>((resolve) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      // Should automatically receive active playlist on connection
      clientSocket.on('playlist-activated', (receivedPlaylist: any) => {
        expect(receivedPlaylist).toBeTruthy();
        expect(receivedPlaylist.id).toBe(playlist.id);
        expect(receivedPlaylist.name).toBe('Active Playlist Test');
        resolve();
      });
    });
  });

  test('should handle request for active playlist', async () => {
    // Create and activate a playlist
    const playlist = await PlaylistModel.create({
      name: 'Request Test Playlist',
      description: 'Test Description'
    });
    
    await SystemStateModel.setActivePlaylistId(playlist.id);
    
    return new Promise<void>((resolve) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('connect', () => {
        clientSocket.emit('request-active-playlist');
      });
      
      clientSocket.on('playlist-activated', (receivedPlaylist: any) => {
        expect(receivedPlaylist).toBeTruthy();
        expect(receivedPlaylist.id).toBe(playlist.id);
        expect(receivedPlaylist.name).toBe('Request Test Playlist');
        resolve();
      });
    });
  });

  test('should handle null active playlist', async () => {
    // Clear any active playlist
    await SystemStateModel.clearActivePlaylist();
    
    return new Promise<void>((resolve) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('playlist-activated', (receivedPlaylist: any) => {
        expect(receivedPlaylist).toBeNull();
        resolve();
      });
    });
  });
});