---
status: pending
priority: p2
issue_id: "016"
tags: [code-review, testing, agent-native]
dependencies: []
---

# Expand integration test coverage across all 7 tools

## Problem Statement

Only 3 of 7 tools have `tools/list` metadata tests. Only 3 of 7 have `callTool` structuredContent tests. Zero tools have error-path integration tests (`isError: true` without `structuredContent`). The biome-runner's destructive tool (`biome_lintFix`) lacks annotation assertions.

## Findings

1. **Agent-native reviewer:** 3/7 tools/list tests, 3/7 callTool tests, 0/7 error-path tests
2. **TypeScript reviewer:** Missing `_resetGitRootCache()` in some integration tests (biome-runner `tools/list` test)
3. **Agent-native reviewer:** `biome_lintFix` destructiveHint:true not asserted in any test
4. **Pattern recognition:** biome-runner and bun-runner missing symlink escape and control character tests that tsc-runner has

## Proposed Solutions

### Option A: Add comprehensive integration tests (Recommended)

For each server, add:
1. `tools/list` test asserting all 4 annotation fields for every tool
2. `callTool` structuredContent test for every tool
3. At least 1 error-path test (invalid path -> `isError: true`, no `structuredContent`)
4. Port tsc-runner's symlink escape test to biome-runner and bun-runner

- **Effort:** Medium
- **Risk:** Low

## Technical Details

**Affected files:**
- `packages/biome-runner/mcp/index.test.ts` -- add tests for biome_lintCheck callTool, biome_lintFix metadata + callTool + error path
- `packages/bun-runner/mcp/index.test.ts` -- add tests for bun_testFile metadata, bun_testCoverage metadata, error path
- `packages/tsc-runner/mcp/index.test.ts` -- add error path test, assert all 4 annotations

## Acceptance Criteria

- [ ] All 7 tools have `tools/list` metadata assertions (title, all 4 annotations, outputSchema)
- [ ] All 7 tools have `callTool` structuredContent shape assertions
- [ ] All 3 servers have at least 1 error-path integration test
- [ ] `biome_lintFix` has `destructiveHint: true` assertion
- [ ] Symlink escape test present in all 3 runners
- [ ] Consistent `_resetGitRootCache()` usage across all integration tests

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Agent-native + pattern + TS reviewers |
