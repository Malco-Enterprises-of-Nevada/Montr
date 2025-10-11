# Testing Quick Start Guide

## Prerequisites

Before running tests, ensure you have:
- Node.js 20.0.0 or higher installed
- npm package manager

## Initial Setup

1. **Install Dependencies**
   ```bash
   cd /home/stripcheese/Montr/server
   npm install
   ```

   This will install all required dependencies including:
   - Jest (test framework)
   - ts-jest (TypeScript support)
   - supertest (HTTP testing)
   - @types/supertest (TypeScript definitions)

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run tests with coverage report
npm run test:coverage

# Run tests in watch mode (auto-rerun on changes)
npm run test:watch

# Run specific test file
npm test media.service.test.ts

# Run tests matching a pattern
npm test -- --testNamePattern="should create"
```

### Coverage Reports

After running `npm run test:coverage`, you can view the coverage report:

```bash
# Open HTML coverage report in browser
xdg-open coverage/lcov-report/index.html

# View coverage summary in terminal
cat coverage/coverage-summary.json
```

## Expected Output

When all tests pass, you should see output similar to:

```
PASS  tests/unit/services/media.service.test.ts
PASS  tests/unit/services/playlist.service.test.ts
PASS  tests/unit/services/client.service.test.ts
PASS  tests/integration/routes/media.routes.test.ts
PASS  tests/integration/routes/playlist.routes.test.ts
PASS  tests/integration/routes/client.routes.test.ts

Test Suites: 6 passed, 6 total
Tests:       183 passed, 183 total
Snapshots:   0 total
Time:        XX.XXXs
```

## Troubleshooting

### Issue: "Module not found" errors

**Solution**: Make sure all dependencies are installed
```bash
npm install
```

### Issue: Tests timeout

**Solution**: Increase timeout in jest.config.js or individual tests
```javascript
jest.setTimeout(15000); // 15 seconds
```

### Issue: Cannot find TypeScript types

**Solution**: Ensure @types packages are installed
```bash
npm install --save-dev @types/node @types/jest @types/supertest
```

### Issue: Database connection errors in tests

**Solution**: Tests use in-memory database mocks. Ensure `tests/setup.ts` is being loaded.
Check `jest.config.js` has:
```javascript
setupFilesAfterEnv: ['<rootDir>/tests/setup.ts']
```

### Issue: Sharp library errors

**Solution**: Sharp is optional and mocked in tests. If you see errors, ensure the mock in `tests/setup.ts` is working.

## Test Organization

```
tests/
├── unit/              # Service layer tests (isolated)
│   └── services/
├── integration/       # API route tests (full stack)
│   └── routes/
├── fixtures/          # Mock data
├── utils/             # Test helpers
└── setup.ts           # Global configuration
```

## Quick Test Development

### Running Specific Tests

```bash
# Run only media tests
npm test media

# Run only unit tests
npm test tests/unit

# Run only integration tests
npm test tests/integration
```

### Debugging Tests

```bash
# Run tests with Node debugger
node --inspect-brk node_modules/.bin/jest --runInBand

# Run with verbose output
npm test -- --verbose

# Show individual test results
npm test -- --verbose --expand
```

## Continuous Integration

These tests are designed to run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run tests
  run: npm test

- name: Generate coverage
  run: npm run test:coverage

- name: Upload coverage
  uses: codecov/codecov-action@v3
  with:
    files: ./coverage/coverage-final.json
```

## Common Tasks

### Adding a New Test

1. Create test file in appropriate directory:
   - Unit tests: `tests/unit/services/[name].service.test.ts`
   - Integration tests: `tests/integration/routes/[name].routes.test.ts`

2. Import fixtures and utilities:
   ```typescript
   import { createMockDatabase } from '../../utils/database.mock';
   import { expectSuccessResponse } from '../../utils/test-helpers';
   import { mockData } from '../../fixtures/[name].fixtures';
   ```

3. Follow the test patterns in existing files

4. Run your new tests:
   ```bash
   npm test [name].test.ts
   ```

### Updating Fixtures

Edit files in `tests/fixtures/`:
- `media.fixtures.ts` - Media file mock data
- `playlist.fixtures.ts` - Playlist mock data
- `client.fixtures.ts` - Client mock data

### Checking Coverage

```bash
# Generate and view coverage
npm run test:coverage

# View coverage for specific file
npm test -- --coverage --collectCoverageFrom="src/services/media.service.ts"
```

## Performance Tips

1. **Use watch mode during development**
   ```bash
   npm run test:watch
   ```

2. **Run only changed tests**
   ```bash
   npm test -- --onlyChanged
   ```

3. **Run tests in parallel** (default behavior)
   Jest runs tests in parallel by default. To run sequentially:
   ```bash
   npm test -- --runInBand
   ```

## Coverage Thresholds

The project maintains these minimum coverage requirements:
- Branches: 70%
- Functions: 70%
- Lines: 70%
- Statements: 70%

Tests will fail if coverage drops below these thresholds.

## Need Help?

1. Check `tests/README.md` for detailed documentation
2. Review `TEST_SUMMARY.md` for test suite overview
3. Look at existing test files for examples
4. Ensure all dependencies are installed with `npm install`

## Success Checklist

- [ ] Node.js 20+ installed
- [ ] Dependencies installed (`npm install`)
- [ ] All tests pass (`npm test`)
- [ ] Coverage meets thresholds (`npm run test:coverage`)
- [ ] No TypeScript errors (`npm run typecheck`)
- [ ] Code follows linting rules (`npm run lint`)

## Next Steps

After running tests successfully:
1. Review coverage report to identify untested code
2. Add tests for any new features
3. Keep tests updated as code changes
4. Run tests before committing code
5. Monitor test performance and optimize if needed
