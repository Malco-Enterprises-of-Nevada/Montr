# Montr Server Tests

This directory contains comprehensive test suites for the Montr server application.

## Test Structure

```
tests/
├── setup.ts                    # Global test setup and configuration
├── fixtures/                   # Mock data for testing
│   ├── index.ts               # Fixtures export index
│   ├── media.fixtures.ts      # Media file fixtures
│   ├── playlist.fixtures.ts   # Playlist fixtures
│   └── client.fixtures.ts     # Client fixtures
├── utils/                      # Test utilities
│   ├── index.ts               # Utils export index
│   ├── database.mock.ts       # Database adapter mocks
│   └── test-helpers.ts        # Common test helpers
├── unit/                       # Unit tests
│   └── services/
│       ├── media.service.test.ts
│       ├── playlist.service.test.ts
│       └── client.service.test.ts
└── integration/                # Integration tests
    └── routes/
        ├── media.routes.test.ts
        ├── playlist.routes.test.ts
        └── client.routes.test.ts
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage

# Run specific test file
npm test -- media.service.test.ts

# Run tests matching a pattern
npm test -- --testNamePattern="should create"
```

## Test Categories

### Unit Tests

Unit tests are located in `tests/unit/` and test individual service methods in isolation.

- **MediaService Tests** (`media.service.test.ts`):
  - File upload and metadata extraction
  - Media retrieval and pagination
  - Media deletion and file cleanup
  - Thumbnail generation (video and image)
  - Duplicate detection by checksum
  - Error handling for invalid files

- **PlaylistService Tests** (`playlist.service.test.ts`):
  - Playlist CRUD operations
  - Adding/removing playlist items
  - Reordering playlist items
  - Playlist statistics calculation
  - Item validation

- **ClientService Tests** (`client.service.test.ts`):
  - Client registration and unregistration
  - Client status tracking
  - Heartbeat updates
  - Playlist assignment
  - Offline client detection
  - Client statistics

### Integration Tests

Integration tests are located in `tests/integration/` and test the full HTTP request/response cycle.

- **Media Routes Tests** (`media.routes.test.ts`):
  - POST /api/media/upload - Single and multiple file uploads
  - GET /api/media - Pagination and filtering
  - GET /api/media/:id - Retrieve media details
  - DELETE /api/media/:id - Delete media files
  - GET /api/media/:id/download - File downloads
  - GET /api/media/:id/thumbnail - Thumbnail retrieval

- **Playlist Routes Tests** (`playlist.routes.test.ts`):
  - POST /api/playlists - Create playlists
  - GET /api/playlists - List all playlists
  - GET /api/playlists/:id - Get playlist with items
  - PUT /api/playlists/:id - Update playlists
  - DELETE /api/playlists/:id - Delete playlists
  - POST /api/playlists/:id/items - Add items
  - PUT /api/playlists/:id/items/:itemId - Update items
  - DELETE /api/playlists/:id/items/:itemId - Remove items
  - POST /api/playlists/:id/reorder - Reorder items
  - GET /api/playlists/:id/stats - Playlist statistics

- **Client Routes Tests** (`client.routes.test.ts`):
  - POST /api/clients/register - Register clients
  - GET /api/clients - List clients with filters
  - GET /api/clients/:id - Get client details
  - PUT /api/clients/:id - Update clients
  - DELETE /api/clients/:id - Unregister clients
  - GET /api/clients/:id/status - Get client status
  - POST /api/clients/:id/status - Record status updates
  - POST /api/clients/:id/heartbeat - Update heartbeat

## Test Utilities

### Fixtures

Test fixtures provide mock data for testing. All fixtures are exported from `tests/fixtures/index.ts`:

- `mockVideoFile`, `mockImageFile`, `mockMediaFiles` - Media file data
- `mockPlaylist`, `mockPlaylistWithItems` - Playlist data
- `mockClient`, `mockClientWithStatus` - Client data
- `createMockMulterFile()` - Create mock uploaded files

### Database Mocks

The `createMockDatabase()` function creates a fully mocked database adapter:

```typescript
import { createMockDatabase, setupCommonMocks } from '../../utils/database.mock';

const mockDb = createMockDatabase();
mockDb.getMediaById.mockResolvedValue(mockVideoFile);
```

Helper functions:
- `createMockDatabase()` - Creates mock database with all methods
- `setupCommonMocks()` - Sets up common mock responses
- `createPaginatedResult()` - Creates paginated result objects

### Test Helpers

Common test utilities for assertions and data generation:

```typescript
import { expectSuccessResponse, expectErrorResponse } from '../../utils/test-helpers';

// Assert successful API response
const data = expectSuccessResponse(response, 201);

// Assert error API response
expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');

// Assert validation errors
expectValidationError(response, ['name', 'description']);
```

Available helpers:
- `expectSuccessResponse()` - Assert successful response
- `expectErrorResponse()` - Assert error response
- `expectValidationError()` - Assert validation errors
- `generateTestUUID()` - Generate test UUIDs
- `deepClone()` - Deep clone objects
- `expectObjectMatch()` - Match objects ignoring fields

## Coverage Goals

The test suite aims for the following minimum coverage:

- **Services**: 80% coverage (statements, branches, functions, lines)
- **Routes**: 70% coverage
- **Overall**: 70% coverage

Current coverage thresholds are configured in `jest.config.js`:

```javascript
coverageThreshold: {
  global: {
    branches: 70,
    functions: 70,
    lines: 70,
    statements: 70,
  },
}
```

## Mocking Strategy

### External Dependencies

The following external dependencies are mocked globally in `tests/setup.ts`:

- **Winston Logger** - Suppresses log output during tests
- **Sharp** - Mocks image processing operations
- **FFmpeg/FFprobe** - Mocked in individual test files

### Database Layer

The database layer is mocked using Jest mocks:

```typescript
jest.mock('../../../src/database/connection');
const mockDb = createMockDatabase();
(getDatabase as jest.Mock).mockResolvedValue(mockDb);
```

### Storage Service

The storage service is mocked for file operations:

```typescript
jest.mock('../../../src/services/storage.service');
(storageService.saveUploadedFile as jest.Mock).mockResolvedValue({...});
```

## Writing New Tests

### Unit Test Template

```typescript
import { ServiceClass } from '../../../src/services/service.class';
import { getDatabase } from '../../../src/database/connection';
import { createMockDatabase } from '../../utils/database.mock';

jest.mock('../../../src/database/connection');

describe('ServiceClass', () => {
  let service: ServiceClass;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    service = new ServiceClass();
  });

  describe('methodName', () => {
    it('should perform expected behavior', async () => {
      // Arrange
      mockDb.someMethod.mockResolvedValue(expectedValue);

      // Act
      const result = await service.methodName(input);

      // Assert
      expect(result).toEqual(expectedValue);
      expect(mockDb.someMethod).toHaveBeenCalledWith(input);
    });
  });
});
```

### Integration Test Template

```typescript
import request from 'supertest';
import { Application } from 'express';
import MontrServer from '../../../src/index';
import { getDatabase } from '../../../src/database/connection';
import { createMockDatabase } from '../../utils/database.mock';
import { expectSuccessResponse, expectErrorResponse } from '../../utils/test-helpers';

jest.mock('../../../src/database/connection');

describe('Route Integration Tests', () => {
  let app: Application;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeAll(() => {
    const server = new MontrServer();
    app = server.getApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('GET /api/endpoint', () => {
    it('should return expected response', async () => {
      // Arrange
      mockDb.someMethod.mockResolvedValue(mockData);

      // Act
      const response = await request(app).get('/api/endpoint');

      // Assert
      const data = expectSuccessResponse(response);
      expect(data).toMatchObject(expectedData);
    });
  });
});
```

## Best Practices

1. **Isolation**: Each test should be independent and not rely on other tests
2. **Mocking**: Mock external dependencies to ensure tests are fast and reliable
3. **Naming**: Use descriptive test names that explain what is being tested
4. **Arrange-Act-Assert**: Follow the AAA pattern in test structure
5. **Coverage**: Aim for high coverage but focus on testing critical paths
6. **Fixtures**: Use fixtures for consistent test data
7. **Cleanup**: Always clean up resources in `afterEach` or `afterAll` hooks
8. **Error Cases**: Test both success and error scenarios
9. **Validation**: Test input validation thoroughly
10. **Edge Cases**: Include tests for edge cases and boundary conditions

## Continuous Integration

These tests are designed to run in CI/CD pipelines:

```bash
# CI test command
npm run test:coverage

# Generate coverage reports
npm run test:coverage -- --coverageReporters=json --coverageReporters=lcov
```

## Troubleshooting

### Common Issues

1. **Timeout Errors**: Increase timeout in jest.config.js or use `jest.setTimeout()`
2. **Mock Not Working**: Ensure mocks are cleared in `beforeEach` hooks
3. **Coverage Too Low**: Check `collectCoverageFrom` patterns in jest.config.js
4. **Type Errors**: Ensure `@types/*` packages are installed

### Debug Mode

Run tests with debug output:

```bash
# Verbose mode
npm test -- --verbose

# Debug specific test
node --inspect-brk node_modules/.bin/jest --runInBand specific.test.ts
```

## Test Statistics

Total test files: **9**
- Unit test files: **3** (MediaService, PlaylistService, ClientService)
- Integration test files: **3** (Media Routes, Playlist Routes, Client Routes)
- Fixture files: **3**
- Utility files: **2**

Estimated test count: **150+ test cases**

## Contributing

When adding new features:

1. Write unit tests for service methods
2. Write integration tests for API routes
3. Add fixtures for new data types
4. Update this README if test structure changes
5. Ensure all tests pass before committing
6. Maintain minimum coverage thresholds
