---
status: complete
priority: p3
issue_id: "035"
tags: [code-review, testing, hooks, cli]
dependencies: []
---

# Missing CLI Failsafe Integration Tests

## Problem Statement

`runCli()` has a robust catch/failsafe path, but there is no integration test proving stdout remains valid JSON on bad subcommand and parse failures.

## Findings

- Failsafe path exists in `packages/claude-hooks/hooks/index.ts`.
- Current tests focus on `createHookHandler` behavior, not full CLI entrypoint failure paths.

## Proposed Solutions

### Option 1: Add subprocess CLI tests (Recommended)

**Approach:** Invoke `index.ts` with invalid argv and malformed stdin; assert exit code and JSON stdout envelope.

**Pros:** Verifies real production path.  
**Cons:** Slightly slower than unit-only tests.  
**Effort:** Small  
**Risk:** Low

### Option 2: Refactor runCli for direct unit seam and mock IO

**Approach:** Inject stdout/stderr writers for deterministic unit assertions.

**Pros:** Very deterministic.  
**Cons:** Adds abstraction just for tests.  
**Effort:** Medium  
**Risk:** Low

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/index.ts`
- Add tests under `packages/claude-hooks/hooks/index.test.ts` or dedicated CLI test file.

## Acceptance Criteria

- [ ] Invalid subcommand yields valid failsafe JSON on stdout.
- [ ] Malformed stdin yields valid failsafe JSON on stdout.
- [ ] No non-JSON text appears on stdout in error paths.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Captured missing e2e safety assertion for CLI boundary.  
**Learnings:** Catch blocks need direct behavior tests, not only code inspection.

