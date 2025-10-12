#!/bin/bash

# Setup script for E2E integration tests

set -e

echo "=========================================="
echo "Montr E2E Integration Tests Setup"
echo "=========================================="
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "Error: Run this script from tests/integration directory"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

echo "✓ Node.js version: $(node --version)"

# Check npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is not installed"
    exit 1
fi

echo "✓ npm version: $(npm --version)"

# Check Rust
if ! command -v cargo &> /dev/null; then
    echo "Error: Rust/Cargo is not installed"
    echo "Install from: https://rustup.rs/"
    exit 1
fi

echo "✓ Cargo version: $(cargo --version)"

# Optional: Check ffmpeg
if command -v ffmpeg &> /dev/null; then
    echo "✓ ffmpeg is installed (version: $(ffmpeg -version | head -1))"
else
    echo "⚠ ffmpeg not found (optional, tests will use minimal fixtures)"
fi

echo ""
echo "Installing test dependencies..."
npm install

echo ""
echo "Building server..."
cd ../../server
if [ ! -d "node_modules" ]; then
    npm install
fi
npm run build

echo ""
echo "Building client (debug mode)..."
cd ../client
cargo build

echo ""
echo "Checking client binary..."
if [ -f "target/debug/montr-client" ]; then
    echo "✓ Client binary found: target/debug/montr-client"
else
    echo "Error: Client binary not found"
    exit 1
fi

echo ""
echo "Creating fixtures directory..."
cd ../tests/integration
mkdir -p fixtures

echo ""
echo "=========================================="
echo "Setup complete!"
echo "=========================================="
echo ""
echo "To run tests:"
echo "  cd tests/integration"
echo "  npm test"
echo ""
echo "To run specific test:"
echo "  npm test e2e-example.test.ts"
echo ""
echo "For more information, see README.md"
echo ""
