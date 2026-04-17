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

### Quick Install via .deb (Raspberry Pi / arm64)

Each GitHub release attaches a `montr-client_<version>_arm64.deb` built for 64-bit ARM
(Raspberry Pi 3/4/5 running 64-bit Raspberry Pi OS or Debian). Install:

```bash
URL=$(curl -s https://api.github.com/repos/Malco-Enterprises-of-Nevada/Montr/releases/latest \
  | grep browser_download_url | grep '_arm64\.deb' | cut -d'"' -f4)
curl -fsSL -o /tmp/montr-client.deb "$URL"
sudo apt install -y libmpv-dev file
sudo dpkg -i /tmp/montr-client.deb
sudo vim /etc/montr-client/config.toml   # set server.url and client.name
sudo systemctl restart montr-client
```

To reinstall or upgrade after a new release, repeat the same commands — `dpkg -i`
on an already-installed package upgrades it in place. Subsequent binary-only
updates are delivered by the built-in auto-updater (see below).

An amd64 `.deb` is also attached for x86_64 Debian/Ubuntu machines.

### Client Auto-Update

The client checks for new releases against a manifest hosted on DigitalOcean Spaces and applies them without manual intervention. The flow is split by platform:

- **macOS**: the client writes directly to its binary directory, replaces itself in place, and restarts.
- **Linux** (packaged install): the client runs as the unprivileged `montr` user and cannot write `/usr/bin/montr-client`. Instead it downloads the new binary, verifies the SHA-256 against the manifest, and atomically renames it into `/var/cache/montr-client/montr-client.staged`. A systemd path unit (`montr-client-updater.path`) watches that location and triggers a root-only oneshot service (`montr-client-updater.service`) which runs `/usr/lib/montr-client/apply-update.sh` to promote the staged file into `/usr/bin/montr-client` and restart `montr-client.service`.

Both units are enabled automatically by `postinst` and disabled on uninstall. Updater logs appear under the `montr-client-updater` syslog tag:

```bash
sudo journalctl -t montr-client-updater -f
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
