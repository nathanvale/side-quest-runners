---
status: complete
priority: p3
issue_id: "047"
tags: [code-review, security, hooks, filesystem]
dependencies: []
---

# Cache Directory Security Check Order Is Ambiguous

## Problem Statement

Directory validation checks `isDirectory()` before `isSymbolicLink()`. For symlink cases this can yield generic "not a directory" behavior and weaker diagnostics.

## Findings

- Location: `packages/claude-hooks/hooks/dedup-store.ts`.
- `lstatSync()` on symlink can make the symlink check effectively secondary.
- Error semantics are less explicit for security-focused troubleshooting.

## Proposed Solutions

### Option 1: Check symlink first, then directory type (Recommended)
**Approach:** Reorder checks and provide explicit security error messaging.
**Pros:** Clearer diagnostics and intent.  
**Cons:** Very minor code churn.  
**Effort:** Small  
**Risk:** Low

### Option 2: Use helper returning typed error codes
**Approach:** Centralize filesystem guard checks with machine-readable error codes.
**Pros:** Better downstream classification.  
**Cons:** More structure than needed for v1.  
**Effort:** Medium  
**Risk:** Low

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/dedup-store.ts`

## Acceptance Criteria
- [ ] Symlinked cache dirs always produce explicit symlink-denied errors.
- [ ] Tests cover reordered checks.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged filesystem guard diagnostic clarity issue.

