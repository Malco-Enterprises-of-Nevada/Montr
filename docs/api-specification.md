# API Specification

**Status**: To be implemented

This document will contain:
- REST API endpoint specifications
- Request/response schemas
- WebSocket message formats
- Authentication details
- Error codes and handling

## REST API Endpoints

### Media Routes
- `POST /api/media/upload`
- `GET /api/media`
- `GET /api/media/:id`
- `DELETE /api/media/:id`
- `GET /api/media/:id/download`

### Playlist Routes
- `POST /api/playlists`
- `GET /api/playlists`
- `GET /api/playlists/:id`
- `PUT /api/playlists/:id`
- `DELETE /api/playlists/:id`

### Client Routes
- `POST /api/clients/register`
- `GET /api/clients`
- `GET /api/clients/:id`
- `PUT /api/clients/:id`
- `DELETE /api/clients/:id`

## WebSocket Protocol

See [websocket-protocol.md](websocket-protocol.md) for details.

---

*This document will be completed during Phase 2 implementation.*
