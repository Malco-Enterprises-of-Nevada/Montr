import { Router, Request, Response, NextFunction } from 'express';
import { PlaylistModel } from '../models/PlaylistModel';
import { PlaylistItemModel } from '../models/PlaylistItemModel';
import { SystemStateModel } from '../models/SystemStateModel';
import { getWebSocketManager } from '../websocket';
import { 
    CreatePlaylistInput, 
    UpdatePlaylistInput,
    CreatePlaylistItemInput,
    UpdatePlaylistItemInput 
} from '../../shared/types/models';

const router = Router();

/**
 * GET /api/playlists - Get all playlists
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const includeItems = req.query.includeItems === 'true';
        const playlists = await PlaylistModel.findAll(includeItems);
        
        res.json({
            success: true,
            data: playlists
        });
    } catch (error) {
        console.error('Error fetching playlists:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: 'Failed to fetch playlists',
                timestamp: new Date()
            }
        });
    }
});

/**
 * GET /api/playlists/:id - Get playlist by ID
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id } = req.params;
        const includeItems = req.query.includeItems === 'true';
        
        const playlist = await PlaylistModel.findById(id, includeItems);
        
        if (!playlist) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId: id },
                    timestamp: new Date()
                }
            });
        }
        
        res.json({
            success: true,
            data: playlist
        });
    } catch (error) {
        console.error('Error fetching playlist:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: 'Failed to fetch playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * POST /api/playlists - Create new playlist
 */
router.post('/', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { name, description } = req.body;
        
        // Validate required fields
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Playlist name is required and must be a non-empty string',
                    timestamp: new Date()
                }
            });
        }
        
        const input: CreatePlaylistInput = {
            name: name.trim(),
            description: description?.trim() || undefined
        };
        
        const playlist = await PlaylistModel.create(input);
        
        res.status(201).json({
            success: true,
            data: playlist,
            message: 'Playlist created successfully'
        });
    } catch (error) {
        console.error('Error creating playlist:', error);
        res.status(500).json({
            error: {
                code: 'CREATION_ERROR',
                message: 'Failed to create playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * PUT /api/playlists/:id - Update playlist
 */
router.put('/:id', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id } = req.params;
        const { name, description } = req.body;
        
        // Check if playlist exists
        const exists = await PlaylistModel.exists(id);
        if (!exists) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId: id },
                    timestamp: new Date()
                }
            });
        }
        
        // Validate input
        const input: UpdatePlaylistInput = {};
        
        if (name !== undefined) {
            if (typeof name !== 'string' || name.trim().length === 0) {
                return res.status(400).json({
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'Playlist name must be a non-empty string',
                        timestamp: new Date()
                    }
                });
            }
            input.name = name.trim();
        }
        
        if (description !== undefined) {
            input.description = typeof description === 'string' ? description.trim() : undefined;
        }
        
        const playlist = await PlaylistModel.update(id, input);
        
        res.json({
            success: true,
            data: playlist,
            message: 'Playlist updated successfully'
        });
    } catch (error) {
        console.error('Error updating playlist:', error);
        res.status(500).json({
            error: {
                code: 'UPDATE_ERROR',
                message: 'Failed to update playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * DELETE /api/playlists/:id - Delete playlist
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id } = req.params;
        
        // Check if playlist exists
        const exists = await PlaylistModel.exists(id);
        if (!exists) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId: id },
                    timestamp: new Date()
                }
            });
        }
        
        // Check if this is the active playlist
        const activePlaylistId = await SystemStateModel.getActivePlaylistId();
        if (activePlaylistId === id) {
            // Clear active playlist if we're deleting it
            await SystemStateModel.clearActivePlaylist();
            
            // Notify WebSocket clients that active playlist was deactivated
            const wsManager = getWebSocketManager();
            if (wsManager) {
                await wsManager.broadcastPlaylistActivated(null);
            }
        }
        
        const success = await PlaylistModel.delete(id);
        
        if (!success) {
            return res.status(500).json({
                error: {
                    code: 'DELETION_ERROR',
                    message: 'Failed to delete playlist',
                    timestamp: new Date()
                }
            });
        }
        
        res.json({
            success: true,
            message: 'Playlist deleted successfully',
            data: { deletedId: id }
        });
    } catch (error) {
        console.error('Error deleting playlist:', error);
        res.status(500).json({
            error: {
                code: 'DELETION_ERROR',
                message: 'Failed to delete playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * POST /api/playlists/:id/activate - Activate playlist
 */
router.post('/:id/activate', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id } = req.params;
        
        // Check if playlist exists
        const playlist = await PlaylistModel.findById(id);
        if (!playlist) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId: id },
                    timestamp: new Date()
                }
            });
        }
        
        // Set as active playlist
        await SystemStateModel.setActivePlaylistId(id);
        
        // Notify WebSocket clients about playlist activation
        const wsManager = getWebSocketManager();
        if (wsManager) {
            await wsManager.broadcastPlaylistActivated(id);
        }
        
        res.json({
            success: true,
            data: {
                activePlaylistId: id,
                playlist: playlist
            },
            message: 'Playlist activated successfully'
        });
    } catch (error) {
        console.error('Error activating playlist:', error);
        res.status(500).json({
            error: {
                code: 'ACTIVATION_ERROR',
                message: 'Failed to activate playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * GET /api/playlists/clients - Get connected WebSocket clients
 */
router.get('/clients', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const wsManager = getWebSocketManager();
        
        if (!wsManager) {
            return res.json({
                success: true,
                data: {
                    clients: [],
                    count: 0
                },
                message: 'WebSocket server not initialized'
            });
        }
        
        const clients = wsManager.getConnectedClients();
        
        res.json({
            success: true,
            data: {
                clients: clients,
                count: clients.length
            },
            message: 'Connected clients retrieved'
        });
    } catch (error) {
        console.error('Error fetching connected clients:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: 'Failed to fetch connected clients',
                timestamp: new Date()
            }
        });
    }
});

/**
 * GET /api/playlists/active - Get currently active playlist
 */
router.get('/active/current', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const activePlaylistId = await SystemStateModel.getActivePlaylistId();
        
        if (!activePlaylistId) {
            return res.json({
                success: true,
                data: null,
                message: 'No active playlist'
            });
        }
        
        const playlist = await PlaylistModel.findById(activePlaylistId, true);
        
        if (!playlist) {
            // Clear invalid active playlist reference
            await SystemStateModel.clearActivePlaylist();
            return res.json({
                success: true,
                data: null,
                message: 'No active playlist (cleared invalid reference)'
            });
        }
        
        res.json({
            success: true,
            data: playlist,
            message: 'Active playlist retrieved'
        });
    } catch (error) {
        console.error('Error fetching active playlist:', error);
        res.status(500).json({
            error: {
                code: 'FETCH_ERROR',
                message: 'Failed to fetch active playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * POST /api/playlists/:id/items - Add item to playlist
 */
router.post('/:id/items', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id: playlistId } = req.params;
        const { mediaFileId, orderIndex, displayDuration } = req.body;
        
        // Check if playlist exists
        const playlistExists = await PlaylistModel.exists(playlistId);
        if (!playlistExists) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId },
                    timestamp: new Date()
                }
            });
        }
        
        // Validate required fields
        if (!mediaFileId || typeof mediaFileId !== 'string') {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'mediaFileId is required and must be a string',
                    timestamp: new Date()
                }
            });
        }
        
        if (orderIndex !== undefined && (typeof orderIndex !== 'number' || orderIndex < 0)) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'orderIndex must be a non-negative number',
                    timestamp: new Date()
                }
            });
        }
        
        const input: CreatePlaylistItemInput = {
            playlist_id: playlistId,
            media_file_id: mediaFileId,
            order_index: orderIndex ?? 0,
            display_duration: displayDuration
        };
        
        const playlistItem = await PlaylistItemModel.create(input);
        
        // Check if this is the active playlist and notify clients
        const activePlaylistId = await SystemStateModel.getActivePlaylistId();
        if (activePlaylistId === playlistId) {
            const wsManager = getWebSocketManager();
            if (wsManager) {
                await wsManager.broadcastPlaylistUpdated(playlistId);
            }
        }
        
        res.status(201).json({
            success: true,
            data: playlistItem,
            message: 'Item added to playlist successfully'
        });
    } catch (error) {
        console.error('Error adding item to playlist:', error);
        res.status(500).json({
            error: {
                code: 'CREATION_ERROR',
                message: 'Failed to add item to playlist',
                timestamp: new Date()
            }
        });
    }
});

/**
 * PUT /api/playlists/:id/items/:itemId - Update playlist item
 */
router.put('/:id/items/:itemId', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id: playlistId, itemId } = req.params;
        const { orderIndex, displayDuration } = req.body;
        
        // Check if playlist exists
        const playlistExists = await PlaylistModel.exists(playlistId);
        if (!playlistExists) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId },
                    timestamp: new Date()
                }
            });
        }
        
        // Validate input
        const input: UpdatePlaylistItemInput = {};
        
        if (orderIndex !== undefined) {
            if (typeof orderIndex !== 'number' || orderIndex < 0) {
                return res.status(400).json({
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'orderIndex must be a non-negative number',
                        timestamp: new Date()
                    }
                });
            }
            input.order_index = orderIndex;
        }
        
        if (displayDuration !== undefined) {
            if (typeof displayDuration !== 'number' || displayDuration <= 0) {
                return res.status(400).json({
                    error: {
                        code: 'VALIDATION_ERROR',
                        message: 'displayDuration must be a positive number',
                        timestamp: new Date()
                    }
                });
            }
            input.display_duration = displayDuration;
        }
        
        const playlistItem = await PlaylistItemModel.update(itemId, input);
        
        if (!playlistItem) {
            return res.status(404).json({
                error: {
                    code: 'ITEM_NOT_FOUND',
                    message: 'Playlist item not found',
                    details: { itemId },
                    timestamp: new Date()
                }
            });
        }
        
        // Check if this is the active playlist and notify clients
        const activePlaylistId = await SystemStateModel.getActivePlaylistId();
        if (activePlaylistId === playlistId) {
            const wsManager = getWebSocketManager();
            if (wsManager) {
                await wsManager.broadcastPlaylistUpdated(playlistId);
            }
        }
        
        res.json({
            success: true,
            data: playlistItem,
            message: 'Playlist item updated successfully'
        });
    } catch (error) {
        console.error('Error updating playlist item:', error);
        res.status(500).json({
            error: {
                code: 'UPDATE_ERROR',
                message: 'Failed to update playlist item',
                timestamp: new Date()
            }
        });
    }
});

/**
 * DELETE /api/playlists/:id/items/:itemId - Remove item from playlist
 */
router.delete('/:id/items/:itemId', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
        const { id: playlistId, itemId } = req.params;
        
        // Check if playlist exists
        const playlistExists = await PlaylistModel.exists(playlistId);
        if (!playlistExists) {
            return res.status(404).json({
                error: {
                    code: 'PLAYLIST_NOT_FOUND',
                    message: 'Playlist not found',
                    details: { playlistId },
                    timestamp: new Date()
                }
            });
        }
        
        const success = await PlaylistItemModel.delete(itemId);
        
        if (!success) {
            return res.status(404).json({
                error: {
                    code: 'ITEM_NOT_FOUND',
                    message: 'Playlist item not found',
                    details: { itemId },
                    timestamp: new Date()
                }
            });
        }
        
        // Check if this is the active playlist and notify clients
        const activePlaylistId = await SystemStateModel.getActivePlaylistId();
        if (activePlaylistId === playlistId) {
            const wsManager = getWebSocketManager();
            if (wsManager) {
                await wsManager.broadcastPlaylistUpdated(playlistId);
            }
        }
        
        res.json({
            success: true,
            message: 'Item removed from playlist successfully',
            data: { deletedItemId: itemId }
        });
    } catch (error) {
        console.error('Error removing item from playlist:', error);
        res.status(500).json({
            error: {
                code: 'DELETION_ERROR',
                message: 'Failed to remove item from playlist',
                timestamp: new Date()
            }
        });
    }
});

export default router;