---
status: complete
priority: p3
issue_id: "043"
tags: [code-review, observability, hooks]
dependencies: []
---

# Observability Stderr Stream Lacks `abort()` Handler

## Problem Statement

Custom writable stream used for LogTape in hooks does not implement `abort()`, unlike runner implementations, risking unflushed logs during abnormal shutdown.

## Findings

- Location: `packages/claude-hooks/hooks/observability.ts`.
- Stream has `start`, `write`, and `close`, but no `abort`.
- Similar runner implementations include abort flush handling.

## Proposed Solutions

### Option 1: Add `abort()` with flush guard (Recommended)
**Approach:** Mirror runner pattern and flush writer on abort.
**Pros:** Better parity and log durability.  
**Cons:** Minimal code increase.  
**Effort:** Small  
**Risk:** Low

### Option 2: Use shared stderr stream utility across packages
**Approach:** Extract common implementation to avoid drift.
**Pros:** Removes duplication.  
**Cons:** Cross-package refactor required.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/observability.ts`

## Acceptance Criteria
- [ ] Abort path flushes and clears writer safely.
- [ ] Behavior matches existing runner stderr stream semantics.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged parity gap in observability stream lifecycle.

