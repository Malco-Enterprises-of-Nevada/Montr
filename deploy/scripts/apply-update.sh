#!/usr/bin/env bash
set -euo pipefail

STAGED="/var/cache/montr-client/montr-client.staged"
TARGET="/usr/bin/montr-client"
LOG_TAG="montr-client-updater"

log() { logger -t "$LOG_TAG" "$*"; echo "$*"; }

if [ ! -f "$STAGED" ]; then
    log "No staged update found at $STAGED, nothing to do"
    exit 0
fi

# Verify the staged file is a valid ELF binary
if ! file "$STAGED" | grep -q "ELF"; then
    log "ERROR: Staged file is not a valid ELF binary, removing"
    rm -f "$STAGED"
    exit 1
fi

# Verify it's a reasonable size (at least 100KB to catch truncated downloads)
FILESIZE=$(stat -c%s "$STAGED" 2>/dev/null || stat -f%z "$STAGED" 2>/dev/null)
if [ "$FILESIZE" -lt 102400 ]; then
    log "ERROR: Staged file is suspiciously small (${FILESIZE} bytes), removing"
    rm -f "$STAGED"
    exit 1
fi

# Copy to a temp file in /usr/bin (same filesystem) for atomic rename
TEMP_TARGET="${TARGET}.new"
cp "$STAGED" "$TEMP_TARGET"
chmod 755 "$TEMP_TARGET"
chown root:root "$TEMP_TARGET"

# Atomic rename within the same filesystem
mv "$TEMP_TARGET" "$TARGET"

# Clean up staged file so the path unit resets
rm -f "$STAGED"

log "Update applied successfully, restarting montr-client.service"
systemctl restart montr-client.service
log "montr-client.service restarted"
