# Deployment Guide

## Prerequisites

- **Server**: Node.js 20+, npm
- **Client**: Rust binary (pre-built or compiled), libmpv
- See [Platform Compatibility](platform-compatibility.md) for detailed requirements

## Server Deployment (Debian/Ubuntu)

### 1. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs
```

### 2. Create system user

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin montr
```

### 3. Install the server

```bash
sudo mkdir -p /opt/montr-server
# Copy built dist/, package.json, package-lock.json to /opt/montr-server
cd /opt/montr-server
sudo npm install --production
sudo chown -R montr:montr /opt/montr-server
```

### 4. Configure

```bash
sudo mkdir -p /etc/montr-server
sudo cp /opt/montr-server/.env.example /etc/montr-server/montr-server.env
sudo vim /etc/montr-server/montr-server.env
```

Key settings to review:
- `DB_TYPE` and `DB_PATH` — database configuration
- `STORAGE_PATH` — where media files are stored
- `API_KEY_REQUIRED` and `API_KEY` — enable for production
- `ALLOWED_ORIGINS` — set to your domain

Create storage and data directories:

```bash
sudo mkdir -p /opt/montr-server/{data,storage,logs}
sudo chown -R montr:montr /opt/montr-server/{data,storage,logs}
```

### 5. Install systemd service

```bash
sudo cp deploy/systemd/montr-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable montr-server
sudo systemctl start montr-server
```

### 6. Verify

```bash
sudo systemctl status montr-server
curl http://localhost:3000/api/health
```

## Client Deployment (Debian/Ubuntu)

### 1. Install libmpv

```bash
sudo apt install libmpv-dev
```

### 2. Install the client binary

```bash
sudo cp montr-client /usr/bin/
sudo chmod +x /usr/bin/montr-client
```

### 3. Configure

```bash
sudo mkdir -p /etc/montr-client
sudo cp config.example.toml /etc/montr-client/config.toml
sudo vim /etc/montr-client/config.toml
```

Key settings:
- `server.url` — point to your Montr server
- `client.name` — display name for this client
- `playback.media_cache_dir` — local cache directory
- `display.fullscreen` — typically `true` for signage

Create cache and log directories:

```bash
sudo mkdir -p /var/cache/montr-client /var/log/montr-client
sudo chown -R montr:montr /var/cache/montr-client /var/log/montr-client
```

### 4. Install systemd service

```bash
sudo cp deploy/systemd/montr-client.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable montr-client
sudo systemctl start montr-client
```

**Note**: The client service requires a graphical session (X11 or Wayland). See the service file for display configuration.

### 5. Verify

```bash
sudo systemctl status montr-client
sudo journalctl -u montr-client -f
```

## Managing Services

```bash
# View logs
sudo journalctl -u montr-server -f
sudo journalctl -u montr-client -f

# Restart
sudo systemctl restart montr-server
sudo systemctl restart montr-client

# Stop
sudo systemctl stop montr-server

# Disable auto-start
sudo systemctl disable montr-client
```

## Arch Linux

The same steps apply — substitute `pacman` for `apt`:

```bash
sudo pacman -S nodejs npm mpv
```

Service file installation and management is identical.
