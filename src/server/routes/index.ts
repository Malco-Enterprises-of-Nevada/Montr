// API routes
import { Router } from 'express';
import mediaRoutes from './mediaRoutes';
import playlistRoutes from './playlistRoutes';

const router = Router();

// Mount routes
router.use('/media', mediaRoutes);
router.use('/playlists', playlistRoutes);

export default router;