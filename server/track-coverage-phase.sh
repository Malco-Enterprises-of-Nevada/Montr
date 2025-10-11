#!/bin/bash
# Coverage Tracking Script for Each Phase
# Usage: ./track-coverage-phase.sh <phase_number> <test_pattern> <component_name>

set -e

PHASE=$1
TEST_PATTERN=$2
COMPONENT=$3

if [ -z "$PHASE" ] || [ -z "$TEST_PATTERN" ] || [ -z "$COMPONENT" ]; then
    echo "Usage: ./track-coverage-phase.sh <phase_number> <test_pattern> <component_name>"
    echo "Example: ./track-coverage-phase.sh 1 'database' 'SQLite Adapter'"
    exit 1
fi

echo "======================================================================"
echo "PHASE $PHASE: $COMPONENT Coverage Tracking"
echo "======================================================================"
echo ""

# Create output directory
mkdir -p coverage-reports

# Run tests for this specific pattern
echo "Step 1: Running tests for $COMPONENT..."
echo "----------------------------------------------------------------------"
npm test -- --testPathPattern="$TEST_PATTERN" 2>&1 | tee "coverage-reports/phase${PHASE}-test-output.log"
TEST_EXIT_CODE=${PIPESTATUS[0]}

echo ""
echo "Step 2: Test Results Summary"
echo "----------------------------------------------------------------------"
if [ $TEST_EXIT_CODE -eq 0 ]; then
    echo "✅ All tests PASSED"
else
    echo "❌ Some tests FAILED (exit code: $TEST_EXIT_CODE)"
fi

# Extract test counts from log
TESTS_ADDED=$(grep -oP 'Tests:.*?(\d+) total' "coverage-reports/phase${PHASE}-test-output.log" | grep -oP '\d+ total' | grep -oP '\d+' || echo "0")
TESTS_PASSED=$(grep -oP 'Tests:.*?(\d+) passed' "coverage-reports/phase${PHASE}-test-output.log" | grep -oP '\d+ passed' | grep -oP '\d+' || echo "0")
TESTS_FAILED=$(grep -oP 'Tests:.*?(\d+) failed' "coverage-reports/phase${PHASE}-test-output.log" | grep -oP '\d+ failed' | grep -oP '\d+' || echo "0")

echo "  Tests Added: $TESTS_ADDED"
echo "  Tests Passed: $TESTS_PASSED"
echo "  Tests Failed: $TESTS_FAILED"
echo ""

# Run coverage for this specific pattern
echo "Step 3: Generating coverage report for $COMPONENT..."
echo "----------------------------------------------------------------------"
npm test -- --coverage --testPathPattern="$TEST_PATTERN" --coverageReporters=text --coverageReporters=json-summary 2>&1 | tee "coverage-reports/phase${PHASE}-coverage-output.log"

echo ""
echo "Step 4: Coverage Analysis"
echo "----------------------------------------------------------------------"

# Extract coverage percentages if coverage/coverage-summary.json exists
if [ -f "coverage/coverage-summary.json" ]; then
    echo "Coverage data found, parsing..."

    # You can parse the JSON here or just show the text output
    echo "See coverage-reports/phase${PHASE}-coverage-output.log for details"
else
    echo "No coverage summary file found"
fi

echo ""
echo "======================================================================"
echo "PHASE $PHASE COMPLETE"
echo "======================================================================"
echo ""
echo "Output files:"
echo "  - coverage-reports/phase${PHASE}-test-output.log"
echo "  - coverage-reports/phase${PHASE}-coverage-output.log"
echo ""
echo "Next: Review the logs and update COVERAGE_TRACKING.md"
echo ""
