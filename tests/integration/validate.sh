#!/bin/bash

# Validation script for E2E integration test infrastructure

set -e

echo "=========================================="
echo "Validating E2E Test Infrastructure"
echo "=========================================="
echo ""

cd "$(dirname "$0")"

# Check required files exist
echo "Checking file structure..."
required_files=(
    "package.json"
    "tsconfig.json"
    "jest.config.js"
    "helpers/server-process.ts"
    "helpers/client-process.ts"
    "helpers/wait-for.ts"
    "helpers/fixtures.ts"
    "helpers/index.ts"
    "e2e-example.test.ts"
    "README.md"
)

for file in "${required_files[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✓ $file"
    else
        echo "  ✗ $file (MISSING)"
        exit 1
    fi
done

echo ""
echo "Checking dependencies..."
if [ -d "node_modules" ]; then
    echo "  ✓ node_modules exists"
else
    echo "  ⚠ node_modules not found (run 'npm install')"
fi

echo ""
echo "Checking server build..."
if [ -f "../../server/dist/index.js" ]; then
    echo "  ✓ Server is built"
else
    echo "  ⚠ Server not built (run 'cd server && npm run build')"
fi

echo ""
echo "Checking client binary..."
if [ -f "../../client/target/debug/montr-client" ]; then
    echo "  ✓ Client debug binary exists"
elif [ -f "../../client/target/release/montr-client" ]; then
    echo "  ✓ Client release binary exists"
else
    echo "  ⚠ Client binary not found (run 'cd client && cargo build')"
fi

echo ""
echo "Checking TypeScript compilation..."
if [ -d "node_modules" ]; then
    npx tsc --noEmit 2>&1 | grep -E "(error TS|found)" || echo "  ✓ TypeScript types are valid"
else
    echo "  ⚠ Skipping TypeScript check (install dependencies first)"
fi

echo ""
echo "Checking fixtures directory..."
mkdir -p fixtures
echo "  ✓ Fixtures directory ready"

echo ""
echo "=========================================="
echo "Validation complete!"
echo "=========================================="
echo ""
echo "Ready to run tests with: npm test"
echo ""
