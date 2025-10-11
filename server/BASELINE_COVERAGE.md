# Test Coverage Baseline Report

**Generated**: 2025-10-10 21:03 UTC
**Status**: BASELINE - Before Phase 1/2/3 Test Additions

---

## Executive Summary

| Metric | Current | Target | Gap |
|--------|---------|--------|-----|
| **Statements** | 61.89% | 70% | -8.11% |
| **Branches** | 40.00% | 70% | -30.00% |
| **Functions** | 58.52% | 70% | -11.48% |
| **Lines** | 62.54% | 70% | -7.46% |

**Status**: 🔴 BELOW TARGET - Need improvement across all metrics

---

## Test Suite Statistics

- **Total Test Suites**: 10 (9 passed, 1 failed)
- **Total Tests**: 278 (270 passed, 8 failed)
- **Execution Time**: 13.273 seconds

### Failed Tests
The following integration tests are failing (not related to coverage improvements):
- WebSocket integration tests (8 failures) - Connection refused errors

---

## Component-Level Coverage Breakdown

### Critical Components (Need Improvement)

#### 1. SQLite Adapter (CRITICAL - 2.3%)
```
File: src/database/adapters/sqlite.adapter.ts
- Statements: 2.3%
- Branches: 0%
- Functions: 0%
- Lines: 2.46%
- Uncovered Lines: 36-591 (556 lines uncovered)
```
**Target for Phase 1**: Bring to 70%+ (need ~400 lines covered)

#### 2. WebSocket Handlers (CRITICAL - 15.95%)
```
File: src/websocket/handlers.ts
- Statements: 15.95%
- Branches: 0%
- Functions: 0%
- Lines: 16.3%
- Uncovered Lines: 30-86, 98-124, 135-151, 159-187, 198-230, 238-264, 275-286, 293-299
```
**Target for Phase 2**: Bring to 70%+ (need significant coverage)

#### 3. Server Index (LOW - 36.28%)
```
File: src/index.ts
- Statements: 36.28%
- Branches: 12.5%
- Functions: 24%
- Lines: 36.28%
- Uncovered Lines: 90, 103, 113, 137-213, 228-275, 281-284
```
**Target for Phase 3**: Bring to 70%+ (need startup/shutdown tests)

#### 4. Database Connection (LOW - 34.61%)
```
File: src/database/connection.ts
- Statements: 34.61%
- Branches: 0%
- Functions: 0%
- Lines: 34.61%
- Uncovered Lines: 20-51, 59-62, 70
```

#### 5. WebSocket Server (LOW - 35.05%)
```
File: src/websocket/server.ts
- Statements: 35.05%
- Branches: 12.12%
- Functions: 25%
- Lines: 35.05%
- Uncovered Lines: 53, 58-60, 71-215, 230-237, 265-266, 280
```

### Well-Covered Components (Good ✅)

#### API Routes (99.3%)
- client.routes.ts: 100%
- media.routes.ts: 98.07%
- playlist.routes.ts: 100%

#### Services (98.95%)
- client.service.ts: 100%
- media.service.ts: 97.47%
- playlist.service.ts: 98.96%
- storage.service.ts: 100%

#### Middleware (93.65%)
- validation.ts: 98.11%
- error-handler.ts: 90.41%

#### WebSocket Types (100%)
- types.ts: 100% (all metrics)

#### Utilities (96.87%)
- logger.ts: 96.87%

---

## Estimated Impact of Planned Tests

### Phase 1: SQLite Adapter Tests
- **Target File**: sqlite.adapter.ts (596 lines)
- **Current Coverage**: 2.3% (~14 lines)
- **Target Coverage**: 70%+ (~417 lines)
- **Lines to Cover**: ~403 lines
- **Estimated Overall Impact**: +8-10% to overall coverage

### Phase 2: WebSocket Handler Tests
- **Target File**: handlers.ts
- **Current Coverage**: 15.95%
- **Target Coverage**: 70%+
- **Estimated Overall Impact**: +4-6% to overall coverage

### Phase 3: Server Startup/Shutdown Tests
- **Target File**: index.ts
- **Current Coverage**: 36.28%
- **Target Coverage**: 70%+
- **Estimated Overall Impact**: +3-5% to overall coverage

### Combined Impact Estimate
If all three phases achieve 70% coverage of their targets:
- **Projected Overall Statements Coverage**: 76-81%
- **Projected Overall Lines Coverage**: 77-82%

**Conclusion**: Achieving 70% overall coverage is VERY LIKELY with all three phases ✅

---

## Coverage Gaps by Category

### Infrastructure & Setup (Low Coverage)
- Server startup/shutdown: 36.28%
- Database connection: 34.61%
- WebSocket server initialization: 35.05%
- Config loading (certain branches): 60.78%

### Data Access Layer (Critical Gap)
- SQLite adapter: 2.3% ⚠️ CRITICAL

### Business Logic (Excellent Coverage)
- All services: 98.95% ✅
- All routes: 99.3% ✅

### Real-time Communication (Needs Work)
- WebSocket handlers: 15.95%
- WebSocket client manager: 76.41% (decent)
- WebSocket types: 100% ✅

---

## Recommendations

### Immediate Priority (Phase 1)
1. ✅ SQLite adapter tests - Will have BIGGEST impact (~8-10% overall improvement)
2. Focus on CRUD operations, error handling, transactions

### High Priority (Phase 2)
1. ✅ WebSocket handler tests - Second biggest impact (~4-6%)
2. Cover all message types: register, status_update, heartbeat, error
3. Test error conditions and validation failures

### Medium Priority (Phase 3)
1. ✅ Server startup/shutdown tests - Good impact (~3-5%)
2. Test graceful shutdown, port conflicts, database initialization
3. Cover middleware chain initialization

### Future Improvements (Post-70%)
1. WebSocket server edge cases
2. Database connection error scenarios
3. Config validation branches
4. Error handler edge cases

---

## Next Steps

1. **Phase 1**: Run `npm test -- tests/unit/database/sqlite.adapter.test.ts`
2. Check coverage: `npm test -- --coverage --testPathPattern=database`
3. Document improvements
4. Move to Phase 2

---

## Appendix: Full Coverage Table

```
-----------------------|---------|----------|---------|---------|-------------------
File                   | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-----------------------|---------|----------|---------|---------|-------------------
All files              |   61.89 |       40 |   58.52 |   62.54 |
 src                   |   36.28 |     12.5 |      24 |   36.28 |
  index.ts             |   36.28 |     12.5 |      24 |   36.28 | 90,103,113,137-213,228-275,281-284
 src/api/middleware    |   93.65 |       85 |   80.64 |   93.54 |
  error-handler.ts     |   90.41 |       80 |    64.7 |   90.27 | 214-215,224,235,242,249,256
  validation.ts        |   98.11 |       90 |     100 |   98.07 | 229
 src/api/routes        |    99.3 |    71.42 |     100 |    99.3 |
  client.routes.ts     |     100 |       50 |     100 |     100 | 43
  media.routes.ts      |   98.07 |       75 |     100 |   98.07 | 50
  playlist.routes.ts   |     100 |      100 |     100 |     100 |
 src/config            |   60.78 |    33.92 |     100 |   60.78 |
  config.ts            |   60.78 |    33.92 |     100 |   60.78 | 82,86,95,99-115,174-198
 src/database          |   34.61 |        0 |       0 |   34.61 |
  connection.ts        |   34.61 |        0 |       0 |   34.61 | 20-51,59-62,70
 src/database/adapters |     2.3 |        0 |       0 |    2.46 |
  sqlite.adapter.ts    |     2.3 |        0 |       0 |    2.46 | 36-591
 src/services          |   98.95 |    91.66 |   98.36 |   98.93 |
  client.service.ts    |     100 |    96.55 |     100 |     100 | 230
  media.service.ts     |   97.47 |    86.36 |     100 |   97.36 | 136-137,230
  playlist.service.ts  |   98.96 |    91.66 |   93.75 |   98.96 | 207
  storage.service.ts   |     100 |      100 |     100 |     100 |
 src/utils             |   96.87 |       90 |     100 |   96.87 |
  logger.ts            |   96.87 |       90 |     100 |   96.87 | 64
 src/websocket         |   44.68 |    27.19 |    39.7 |   45.25 |
  client-manager.ts    |   76.41 |    65.85 |   73.07 |   76.41 | 113-120,169-171,196-210,251-253,269-280
  handlers.ts          |   15.95 |        0 |       0 |    16.3 | 30-86,98-124,135-151,159-187,198-230,238-264,275-286,293-299
  index.ts             |       0 |      100 |       0 |       0 | 6-14
  server.ts            |   35.05 |    12.12 |      25 |   35.05 | 53,58-60,71-215,230-237,265-266,280
  types.ts             |     100 |      100 |     100 |     100 |
-----------------------|---------|----------|---------|---------|-------------------
```
