# WebSocket Protocol Specification

**Status**: To be implemented

This document will define:
- Connection establishment
- Message formats
- Client-server message types
- Heartbeat mechanism
- Reconnection strategy
- Error handling

## Connection

- **URL**: `ws://server:3000/ws`
- **Protocol**: JSON over WebSocket

## Message Types

### Client → Server

#### Register
```json
{
  "type": "register",
  "clientId": "uuid",
  "version": "1.0.0",
  "capabilities": { "video": true, "image": true }
}
```

#### Status Update
```json
{
  "type": "status_update",
  "clientId": "uuid",
  "currentMedia": { "id": 123, "filename": "video.mp4" },
  "position": 45.2,
  "isPlaying": true,
  "timestamp": 1234567890
}
```

### Server → Client

#### Playlist Assigned
```json
{
  "type": "playlist_assigned",
  "playlistId": 5,
  "items": [...]
}
```

---

*This document will be completed during Phase 2 implementation.*
