---
status: complete
priority: p3
issue_id: "036"
tags: [code-review, observability, hooks, reliability]
dependencies: []
---

# Dedup Cache Corruption Read Path Lacks Observable Signal

## Problem Statement

Cache read corruption currently fails open silently, reducing visibility into repeated corruption or hostile filesystem conditions.

## Findings

- `readDedupState()` catches parse/validation errors and returns empty state.
- No metric/log is emitted at this point.
- Location: `packages/claude-hooks/hooks/dedup-store.ts`.

## Proposed Solutions

### Option 1: Emit explicit corruption metric on read failure (Recommended)

**Approach:** Add a single metric/log event (stderr only) when read parse/validation fails.

**Pros:** Maintains fail-open behavior with better operations signal.  
**Cons:** Minor noise risk if persistent corruption exists.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add best-effort quarantine rename for bad cache files

**Approach:** Move corrupt file to `.corrupt.<ts>` before rebuilding.

**Pros:** Better debugging artifact retention.  
**Cons:** More filesystem complexity.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/dedup-store.ts`
- Optional: `packages/claude-hooks/hooks/observability.ts`

## Acceptance Criteria

- [ ] Corrupt cache reads emit one structured metric/log entry.
- [ ] Hook behavior remains fail-open.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Logged observability blind spot on corruption recovery path.  
**Learnings:** Silent fail-open is safe for behavior but weak for detection.

