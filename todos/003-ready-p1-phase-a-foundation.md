---
status: ready
priority: p1
issue_id: "003"
tags: [mcp, sdk, foundation, smoke-test]
dependencies: ["001"]
---

# Phase A: Foundation -- SDK upgrade and smoke tests

## Problem Statement

Before any tool contract or reliability changes, the MCP SDK must be upgraded to `^1.27.1` (security fix in 1.26.0) and verified working across all three runners. The exact shape of this phase depends on Phase 0's architecture decision.

## Findings

- Current SDK: `@modelcontextprotocol/sdk@1.25.3` (via `@side-quest/core`)
- Security fix in 1.26.0 (GHSA-345p-7cg4-v4c7)
- No breaking changes between 1.25.3 and 1.27.1
- Must verify `title` and `outputSchema` passthrough at runtime

## Proposed Solutions

### Option 1: If keeping core

**Approach:** Bump `@modelcontextprotocol/sdk` to `^1.27.1` in `@side-quest/core`. Verify `tool()` passes `title` and `outputSchema` to SDK. Smoke test all three runners.

**Effort:** 1-2 hours

**Risk:** Low

---

### Option 2: If dropping core

**Approach:** Replace `@side-quest/core` with direct `@modelcontextprotocol/sdk@^1.27.1` dependency. Migrate tool registration to raw `McpServer` API. Inline `spawnWithTimeout`, `findNearestConfig`, validators. Smoke test all three runners.

**Effort:** 4-6 hours

**Risk:** Medium

## Recommended Action

To be filled after Phase 0 decision.

## Acceptance Criteria

- [ ] MCP SDK at `^1.27.1`
- [ ] `title` field passes through to SDK at runtime
- [ ] `outputSchema` field passes through to SDK at runtime
- [ ] tsc-runner smoke test passes
- [ ] bun-runner smoke test passes
- [ ] biome-runner smoke test passes
- [ ] No other changes in this phase

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase A
- Blocked by Phase 0 (issue 001)
