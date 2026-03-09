---
status: complete
priority: p2
issue_id: "046"
tags: [code-review, security, reliability, hooks]
dependencies: []
---

# Security Errors In Dedup Read Path Are Silently Downgraded

## Problem Statement

`readDedupState()` catches all exceptions and returns empty state, including potential security violations like symlink attacks or ownership mismatches.

## Findings

- Location: `packages/claude-hooks/hooks/dedup-store.ts`.
- `assertNotSymlink()` and directory ownership checks can throw.
- Broad catch returns `{ entries: {} }` with no differentiated handling.

## Proposed Solutions

### Option 1: Differentiate security errors from corruption (Recommended)
**Approach:** Detect and surface security-class errors via dedicated metric/log and stronger fallback messaging.
**Pros:** Better incident visibility while preserving fail-open behavior.  
**Cons:** Slightly more error plumbing.  
**Effort:** Small  
**Risk:** Low

### Option 2: Hard-fail on security errors
**Approach:** Re-throw security errors and let caller handle explicit failure output.
**Pros:** Stronger hardening stance.  
**Cons:** Could reduce availability under benign env oddities.  
**Effort:** Small  
**Risk:** Medium

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/dedup-store.ts`
- Affected: `packages/claude-hooks/hooks/posttool.ts`
- Affected: `packages/claude-hooks/hooks/posttool-failure.ts`

## Acceptance Criteria
- [ ] Security-related store errors are explicitly classified.
- [ ] Classification is observable in metrics/logs.
- [ ] Hook output policy for these failures is documented and tested.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged broad-catch security signal loss.

