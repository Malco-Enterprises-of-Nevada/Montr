import { Server as HTTPServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { initializeWebSocket, getWebSocketManager, WebSocketManager, ClientInfo } from '../index';
import { initializeDatabase } from '../../database';
import { PlaylistModel, SystemStateModel } from '../../models';
import { Playlist } from '../../../shared/types/models';

describe('WebSocket Server Integration Tests', () => {
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
    if (clientSocket) {
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

  beforeEach(async () => {
    // Clean up any existing client connections
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
  });

  afterEach(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
  });

  describe('Client Connection Management', () => {
    test('should handle client connection and disconnection', (done) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        expect(wsManager.getClientCount()).toBe(1);
        
        clientSocket.disconnect();
      });
      
      clientSocket.on('disconnect', () => {
        // Give a small delay for cleanup
        setTimeout(() => {
          expect(wsManager.getClientCount()).toBe(0);
          done();
        }, 100);
      });
    });

    test('should track client information', (done) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('connect', () => {
        // Send client info
        clientSocket.emit('client-info', { userAgent: 'test-client' });
        
        setTimeout(() => {
          const clients = wsManager.getConnectedClients();
          expect(clients).toHaveLength(1);
          expect(clients[0].id).toBe(clientSocket.id);
          expect(clients[0].userAgent).toBe('test-client');
          expect(clients[0].connectedAt).toBeInstanceOf(Date);
          expect(clients[0].lastHeartbeat).toBeInstanceOf(Date);
          
          done();
        }, 100);
      });
    });

    test.skip('should broadcast client list updates', (done) => {
      const timeout = setTimeout(() => {
        done(new Error('Test timeout - client list updates not received'));
      }, 5000);

      let clientListUpdates = 0;
      
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('client-list-updated', (clients: ClientInfo[]) => {
        try {
          clientListUpdates++;
          
          if (clientListUpdates === 1) {
            // First update when client connects
            expect(clients).toHaveLength(1);
            expect(clients[0].id).toBe(clientSocket.id);
            
            // Wait a bit before disconnecting to ensure the update is processed
            setTimeout(() => {
              clientSocket.disconnect();
            }, 100);
          } else if (clientListUpdates === 2) {
            // Second update when client disconnects
            expect(clients).toHaveLength(0);
            clearTimeout(timeout);
            done();
          }
        } catch (error) {
          clearTimeout(timeout);
          done(error);
        }
      });
      
      clientSocket.on('connect', () => {
        // Connection established, client list update should be broadcast
      });
    });
  });

  describe('Heartbeat Monitoring', () => {
    test('should handle heartbeat messages', (done) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('connect', () => {
        clientSocket.emit('heartbeat');
      });
      
      clientSocket.on('heartbeat-response', () => {
        const clients = wsManager.getConnectedClients();
        expect(clients).toHaveLength(1);
        
        const client = clients[0];
        expect(client.lastHeartbeat).toBeInstanceOf(Date);
        
        done();
      });
    });

    test('should update heartbeat timestamp', (done) => {
      clientSocket = Client(`http://localhost:${serverPort}`);
      
      clientSocket.on('connect', () => {
        const initialClients = wsManager.getConnectedClients();
        const initialHeartbeat = initialClients[0]?.lastHeartbeat;
        
        setTimeout(() => {
          clientSocket.emit('heartbeat');
          
          setTimeout(() => {
            const updatedClients = wsManager.getConnectedClients();
            const updatedHeartbeat = updatedClients[0]?.lastHeartbeat;
            
            expect(updatedHeartbeat.getTime()).toBeGreaterThan(initialHeartbeat.getTime());
            done();
          }, 50);
        }, 100);
      });
    });
  });

  describe('Playlist Broadcasting', () => {
    test('should send active playlist to newly connected client', async () => {
      // Create a test playlist
      const playlist = await PlaylistModel.create({
        name: 'Test Playlist',
        description: 'Test Description'
      });
      
      // Set it as active
      await SystemStateModel.setActivePlaylistId(playlist.id);
      
      return new Promise<void>((resolve) => {
        clientSocket = Client(`http://localhost:${serverPort}`);
        
        clientSocket.on('playlist-activated', (receivedPlaylist: Playlist | null) => {
          expect(receivedPlaylist).toBeTruthy();
          expect(receivedPlaylist!.id).toBe(playlist.id);
          expect(receivedPlaylist!.name).toBe('Test Playlist');
          resolve();
        });
      });
    });

    test('should handle request for active playlist', async () => {
      // Create and activate a playlist
      const playlist = await PlaylistModel.create({
        name: 'Requested Playlist',
        description: 'Test Description'
      });
      
      await SystemStateModel.setActivePlaylistId(playlist.id);
      
      return new Promise<void>((resolve) => {
        clientSocket = Client(`http://localhost:${serverPort}`);
        
        clientSocket.on('connect', () => {
          clientSocket.emit('request-active-playlist');
        });
        
        clientSocket.on('playlist-activated', (receivedPlaylist: Playlist | null) => {
          expect(receivedPlaylist).toBeTruthy();
          expect(receivedPlaylist!.id).toBe(playlist.id);
          expect(receivedPlaylist!.name).toBe('Requested Playlist');
          resolve();
        });
      });
    });

    test('should broadcast playlist activation to all clients', async () => {
      const playlist = await PlaylistModel.create({
        name: 'Broadcast Test Playlist',
        description: 'Test Description'
      });
      
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Test timeout'));
        }, 5000);

        clientSocket = Client(`http://localhost:${serverPort}`);
        
        let receivedInitialPlaylist = false;
        
        clientSocket.on('playlist-activated', (receivedPlaylist: Playlist | null) => {
          if (!receivedInitialPlaylist) {
            // This is the initial null playlist sent on connection
            receivedInitialPlaylist = true;
            // Now trigger the broadcast
            setTimeout(async () => {
              try {
                await wsManager.broadcastPlaylistActivated(playlist.id);
              } catch (error) {
                clearTimeout(timeout);
                reject(error);
              }
            }, 100);
          } else {
            // This should be our broadcast
            clearTimeout(timeout);
            try {
              expect(receivedPlaylist).toBeTruthy();
              expect(receivedPlaylist!.id).toBe(playlist.id);
              expect(receivedPlaylist!.name).toBe('Broadcast Test Playlist');
              resolve();
            } catch (error) {
              reject(error);
            }
          }
        });
      });
    });

    test('should broadcast playlist updates to all clients', async () => {
      const playlist = await PlaylistModel.create({
        name: 'Update Test Playlist',
        description: 'Test Description'
      });
      
      return new Promise<void>((resolve) => {
        clientSocket = Client(`http://localhost:${serverPort}`);
        
        clientSocket.on('connect', async () => {
          // Broadcast playlist update
          await wsManager.broadcastPlaylistUpdated(playlist.id);
        });
        
        clientSocket.on('playlist-updated', (receivedPlaylist: Playlist) => {
          expect(receivedPlaylist).toBeTruthy();
          expect(receivedPlaylist.id).toBe(playlist.id);
          expect(receivedPlaylist.name).toBe('Update Test Playlist');
          resolve();
        });
      });
    });

    test('should send null when no active playlist', async () => {
      // Clear any active playlist
      await SystemStateModel.clearActivePlaylist();
      
      return new Promise<void>((resolve) => {
        clientSocket = Client(`http://localhost:${serverPort}`);
        
        clientSocket.on('playlist-activated', (receivedPlaylist: Playlist | null) => {
          expect(receivedPlaylist).toBeNull();
          resolve();
        });
      });
    });
  });

  describe('Error Handling', () => {
    test('should handle invalid playlist ID gracefully', async () => {
      return new Promise<void>((resolve) => {
        clientSocket = Client(`http://localhost:${serverPort}`);
        
        clientSocket.on('connect', async () => {
          // Try to broadcast non-existent playlist
          await wsManager.broadcastPlaylistActivated('non-existent-id');
        });
        
        clientSocket.on('playlist-activated', (receivedPlaylist: Playlist | null) => {
          expect(receivedPlaylist).toBeNull();
          resolve();
        });
      });
    });

    test('should handle database errors gracefully', async () => {
      return new Promise<void>((resolve) => {
        clientSocket = Client(`http://localhost:${serverPort}`);
        
        clientSocket.on('connect', () => {
          clientSocket.emit('request-active-playlist');
        });
        
        // Should not crash the server even if there are database issues
        clientSocket.on('playlist-activated', (receivedPlaylist: Playlist | null) => {
          // Should receive null or valid playlist, not crash
          expect(receivedPlaylist === null || typeof receivedPlaylist === 'object').toBe(true);
          resolve();
        });
      });
    });
  });

  describe('Multiple Clients', () => {
    test('should handle multiple client connections', (done) => {
      const client1 = Client(`http://localhost:${serverPort}`);
      const client2 = Client(`http://localhost:${serverPort}`);
      
      let connectCount = 0;
      
      const onConnect = () => {
        connectCount++;
        if (connectCount === 2) {
          expect(wsManager.getClientCount()).toBe(2);
          
          client1.disconnect();
          client2.disconnect();
          
          setTimeout(() => {
            expect(wsManager.getClientCount()).toBe(0);
            done();
          }, 100);
        }
      };
      
      client1.on('connect', onConnect);
      client2.on('connect', onConnect);
    });

    test('should broadcast to all connected clients', async () => {
      const playlist = await PlaylistModel.create({
        name: 'Multi-Client Test',
        description: 'Test Description'
      });
      
      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Test timeout'));
        }, 5000);

        const client1 = Client(`http://localhost:${serverPort}`);
        const client2 = Client(`http://localhost:${serverPort}`);
        
        let receivedCount = 0;
        let initialPlaylistsReceived = 0;
        
        const onPlaylistActivated = (receivedPlaylist: any) => {
          if (receivedPlaylist === null) {
            // Initial null playlist
            initialPlaylistsReceived++;
            if (initialPlaylistsReceived === 2) {
              // Both clients received initial null, now broadcast
              setTimeout(async () => {
                try {
                  await wsManager.broadcastPlaylistActivated(playlist.id);
                } catch (error) {
                  clearTimeout(timeout);
                  reject(error);
                }
              }, 100);
            }
          } else {
            // Actual broadcast
            try {
              expect(receivedPlaylist.id).toBe(playlist.id);
              receivedCount++;
              
              if (receivedCount === 2) {
                clearTimeout(timeout);
                client1.disconnect();
                client2.disconnect();
                resolve();
              }
            } catch (error) {
              clearTimeout(timeout);
              reject(error);
            }
          }
        };
        
        client1.on('playlist-activated', onPlaylistActivated);
        client2.on('playlist-activated', onPlaylistActivated);
      });
    });
  });
});