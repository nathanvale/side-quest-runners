---
status: complete
priority: p2
issue_id: "040"
tags: [code-review, reliability, hooks]
dependencies: []
---

# Claude Mapper Can Crash On Unresolvable `cwd`

## Problem Statement

`resolveProjectRoot()` uses `realpathSync()` without a guard. If `cwd` is invalid/unmounted, hook processing throws before graceful fallback behavior.

## Findings

- Location: `packages/claude-hooks/hooks/claude-mapper.ts`.
- `realpathSync(base)` is not wrapped in `try/catch`.
- A malformed `cwd` from hook input can force error-path behavior unexpectedly.

## Proposed Solutions

### Option 1: Guard `realpathSync` with fallback (Recommended)
**Approach:** Catch failure and fallback to `process.cwd()` or a safe normalized value.
**Pros:** Improves robustness.  
**Cons:** Slightly less strict mapping semantics.  
**Effort:** Small  
**Risk:** Low

### Option 2: Return `null` intent on path resolution error
**Approach:** Treat bad `cwd` as unsupported payload.
**Pros:** Explicit fail-open.  
**Cons:** Drops dedup for those events.  
**Effort:** Small  
**Risk:** Low

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/claude-mapper.ts`

## Acceptance Criteria
- [ ] Invalid `cwd` does not crash mapping path.
- [ ] Regression test covers bad `cwd` input.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged unguarded path resolution risk.  
**Learnings:** Input resilience should not depend on filesystem stability.

