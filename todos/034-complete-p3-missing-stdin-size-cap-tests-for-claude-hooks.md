---
status: complete
priority: p3
issue_id: "034"
tags: [code-review, testing, hooks, input-validation]
dependencies: []
---

# Missing Stdin Size-Cap Tests For Claude Hooks

## Problem Statement

The stdin cap logic (`HOOK_STDIN_MAX_BYTES`) is implemented but untested, leaving OOM-prevention behavior unverified.

## Findings

- Logic exists in `packages/claude-hooks/hooks/stdio.ts`.
- No tests assert overflow behavior or empty payload behavior.

## Proposed Solutions

### Option 1: Add stdio unit tests (Recommended)

**Approach:** Test `readStdinJsonWithLimit()` and `getStdinMaxBytes()` with representative edge cases.

**Pros:** Fast, deterministic, complete branch coverage.  
**Cons:** Requires stdin mocking strategy.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add CLI integration tests only

**Approach:** Pipe oversized payload into hook CLI and assert failsafe output.

**Pros:** End-to-end verification.  
**Cons:** Slower and less granular diagnostics.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/stdio.ts`
- Add: `packages/claude-hooks/hooks/stdio.test.ts`

## Acceptance Criteria

- [ ] Overflow input triggers safe failure behavior.
- [ ] Empty input path is covered.
- [ ] Env override parsing for max bytes is covered.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Logged input-cap test gap.  
**Learnings:** Safety-critical input boundaries need explicit tests.

