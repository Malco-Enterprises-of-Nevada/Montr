# Communication Protocol

**Status**: To be implemented

This document defines the shared protocol between server and client, including:
- Message format specifications
- Version compatibility
- Backward compatibility strategy

## Protocol Version

Current: `1.0.0`

## Message Format

All messages are JSON-encoded.

### Common Structure

```json
{
  "type": "message_type",
  "version": "1.0.0",
  "data": { /* message-specific data */ }
}
```

## Client → Server Messages

### register
### status_update
### heartbeat
### error

## Server → Client Messages

### playlist_assigned
### playlist_updated
### command
### heartbeat_ack

---

*This document will be completed during Phase 1-2 implementation.*
