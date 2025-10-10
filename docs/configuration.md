# Configuration Reference

**Status**: To be implemented

This document will provide:
- Complete configuration options for server
- Complete configuration options for client
- Environment variable reference
- Configuration examples

## Server Configuration

### Environment Variables

```bash
# Server configuration
PORT=3000
HOST=0.0.0.0

# Database configuration
DB_TYPE=sqlite
DB_PATH=./data/montr.db

# Storage configuration
STORAGE_PATH=./storage
MAX_UPLOAD_SIZE_MB=500
```

## Client Configuration

### config.toml

```toml
[server]
url = "http://server:3000"

[client]
id = "uuid"
name = "Client-01"

[playback]
default_image_duration = 5
loop_playlist = true
```

---

*This document will be completed during Phase 2-4 implementation.*
