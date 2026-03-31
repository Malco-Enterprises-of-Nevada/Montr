#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== Building All Montr Components ==="

"$SCRIPT_DIR/build-server.sh"
"$SCRIPT_DIR/build-client-linux.sh"

echo "=== All builds complete ==="
