---
status: ready
priority: p2
issue_id: "015"
tags: [code-review, testing, quality]
dependencies: []
---

# Zero Integration Test Coverage Across All Runners

## Problem Statement

All three MCP runners (`tsc-runner`, `bun-runner`, `biome-runner`) have zero integration or handler-level test coverage. Existing tests only cover pure parser functions:

- `tsc-runner`: tests `parseTscOutput` (string -> structured data)
- `bun-runner`: tests parse functions (if any)
- `biome-runner`: tests `parseBiomeOutput` (if any)

No tests exercise the full tool handler pipeline: tool registration -> argument validation -> subprocess spawn -> output parsing -> response formatting -> `CallToolResult` construction. This means:

1. `structuredContent` / `outputSchema` mismatches will only be caught at runtime by agents.
2. Handler-level bugs (wrong `isError` value, missing fields, incorrect content type) are invisible.
3. The `InMemoryTransport` + `server-factory` testing pattern described in the plan (lines 358-376) has no existing implementation to build on.

The plan mentions InMemoryTransport and server-factory as the post-migration testing strategy but does not flag the current zero-coverage gap as a Phase A blocker or prerequisite.

## Findings

1. The plan's "Testing strategy post-migration" section (lines 358-376) describes the correct approach: `createRunnerServer()` factory + `InMemoryTransport.createLinkedPair()`.
2. The plan's smoke test definition (line 378) includes `tools/list` returning expected tool names -- this is an integration test.
3. The plan's acceptance criteria do not include "integration test coverage" as a Phase A deliverable. It appears only in the "fix-while-migrating" context.
4. SDK's `structuredContent` validation throws a hard error on schema mismatch (not graceful `isError`). Without integration tests, these mismatches will only surface when agents call the tools.
5. The plan correctly identifies that "current test surface is light" (line 355) but treats this as an observation rather than a blocker.
6. `InMemoryTransport` is available from `@modelcontextprotocol/sdk/inMemory.js` -- no additional dependencies needed.

## Proposed Solutions

### Solution 1: Add integration test requirement to Phase A acceptance criteria

Make "at least one integration test per runner" a Phase A acceptance criterion. Each test must exercise the full pipeline via InMemoryTransport.

```typescript
// Example integration test structure
test('tsc_check returns structured output for real tsconfig', async () => {
  const server = createRunnerServer()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  const result = await client.callTool({ name: 'tsc_check', arguments: { path: './tsconfig.json' } })

  expect(result.isError).toBe(false)
  expect(result.structuredContent).toMatchObject({
    exitCode: expect.any(Number),
    errorCount: expect.any(Number),
  })
})
```

- **Pros:** Catches `structuredContent`/`outputSchema` mismatches before agent consumption. Validates the full pipeline. Establishes the testing pattern for all future tool additions.
- **Cons:** Adds scope to Phase A. Integration tests are slower (spawn subprocesses). Requires real filesystem fixtures.
- **Effort:** Medium (4-6 hours per runner -- test scaffold + 1-2 integration tests each)
- **Risk:** Low. The investment prevents runtime failures that are much harder to debug.

### Solution 2: Create a test scaffold during Phase 0 PoC

The Phase 0 PoC already uses `InMemoryTransport` as a stretch goal (item 6). Extend the PoC to produce a reusable test scaffold that Phase A inherits.

- **Pros:** PoC already validates InMemoryTransport works with Bun. Scaffold provides a template for Phase A. "PoC as seed" philosophy (plan line 105) supports this.
- **Cons:** Adds scope to the 1-hour PoC time-box. May push stretch goal further.
- **Effort:** Small (1-2 hours additional PoC scope, or defer to Phase A if time-boxed out)
- **Risk:** Low. If time-boxed out, the scaffold becomes a Phase A day-one task.

### Solution 3: Defer to Phase B but document current coverage gap

Acknowledge the gap in the plan, add it to the Phase B backlog, and proceed with Phase A using only unit tests.

- **Pros:** Keeps Phase A scope focused on migration. No additional test infrastructure to build.
- **Cons:** `structuredContent` mismatches remain uncaught through Phase A. Every tool migration is a "hope it works" deployment. Contradicts the plan's own emphasis on `outputSchema` as first-class.
- **Effort:** Trivial (plan text change only)
- **Risk:** High. Schema mismatches cause hard SDK errors at runtime. Agents receive opaque error responses instead of structured data.

## Technical Details

The `InMemoryTransport` pattern from the MCP SDK:

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

// Create linked transport pair
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

// Connect both sides
const server = createRunnerServer()
const client = new Client({ name: 'test-client', version: '1.0.0' })
await Promise.all([
  server.connect(serverTransport),
  client.connect(clientTransport),
])

// Call tools and assert
const result = await client.callTool({ name: 'tsc_check', arguments: { path: '.' } })
```

Key things to test per runner:
- `tools/list` returns expected tool names, titles, and outputSchema
- Tool call with valid arguments returns correct `structuredContent`
- Tool call with invalid path returns appropriate error
- `isError` semantics are correct (false for domain results, true for operational errors)

## Acceptance Criteria

- [ ] At least one integration test per runner that exercises the full handler pipeline
- [ ] InMemoryTransport pattern demonstrated and working with Bun
- [ ] `structuredContent` validated against `outputSchema` in tests
- [ ] `tools/list` response verified (tool names, titles, annotations present)
- [ ] Test failures produce clear diagnostics (not opaque SDK errors)

## Work Log

| Date | Note |
|------|------|
| 2026-03-04 | Code review finding documented |

## Resources

- Plan section: "Testing strategy post-migration" (lines 358-376)
- Plan section: "Smoke test definition" (line 378)
- Plan section: "PoC stretch goal -- InMemoryTransport" (line 99)
- [MCPcat testing guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/)
- [MCP SDK InMemoryTransport source](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/inMemory.ts)
- [SDK structuredContent validation (Issue #654)](https://github.com/modelcontextprotocol/typescript-sdk/issues/654)
