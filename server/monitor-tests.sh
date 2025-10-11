#!/bin/bash

echo "Monitoring test file creation and execution..."
echo "Press Ctrl+C to stop"
echo ""

for i in {1..60}; do
    echo "=== Check #$i at $(date +%H:%M:%S) ==="

    # Count test files
    TEST_COUNT=$(find tests -type f -name "*.test.ts" | wc -l)
    echo "Total test files: $TEST_COUNT"

    # Check for Phase 2
    if [ -f "tests/unit/websocket/handlers.test.ts" ]; then
        echo "✅ Phase 2: handlers.test.ts EXISTS"
    else
        echo "⏳ Phase 2: handlers.test.ts NOT YET"
    fi

    # Check for Phase 3
    if [ -f "tests/unit/server/index.test.ts" ]; then
        echo "✅ Phase 3: index.test.ts EXISTS"
    else
        echo "⏳ Phase 3: index.test.ts NOT YET"
    fi

    # Try Phase 1 test
    echo "Testing Phase 1 (SQLite)..."
    npm test -- tests/unit/database/sqlite.adapter.test.ts 2>&1 | grep -E "(PASS|Test Suites:|Tests:)" | head -3

    echo ""

    # Wait 30 seconds before next check
    if [ $i -lt 60 ]; then
        sleep 30
    fi
done

echo "Monitoring complete"
