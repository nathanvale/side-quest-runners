---
status: complete
priority: p2
issue_id: "033"
tags: [code-review, testing, tsc-runner, reliability]
dependencies: []
---

# TSC Runner Missing Output Truncation Tests

## Problem Statement

`tsc-runner` has truncation safeguards but no explicit regression tests for oversized stdout/stderr behavior.

## Findings

- Truncation checks exist in `packages/tsc-runner/mcp/index.ts`.
- Equivalent tests exist in biome and bun runners.
- `packages/tsc-runner/mcp/index.test.ts` lacks truncation-path assertions.

## Proposed Solutions

### Option 1: Add focused truncation tests (Recommended)

**Approach:** Add deterministic tests for capped stream behavior and expected `SPAWN_FAILURE`.

**Pros:** Parity with other runners.  
**Cons:** Might need small helper export or seam.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add only integration-level oversized-output test

**Approach:** Trigger large compiler output and assert failure envelope.

**Pros:** Black-box confidence.  
**Cons:** Harder to keep stable cross-env.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/tsc-runner/mcp/index.test.ts`

## Acceptance Criteria

- [ ] Tests cover both stdout and stderr truncation paths.
- [ ] Failure output includes expected code and remediation guidance.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Recorded coverage gap against biome/bun parity baseline.  
**Learnings:** Guardrail code shipped, but test coverage lags.

