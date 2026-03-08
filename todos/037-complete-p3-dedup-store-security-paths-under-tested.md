---
status: complete
priority: p3
issue_id: "037"
tags: [code-review, security, testing, hooks]
dependencies: []
---

# Dedup Store Security Paths Are Under-Tested

## Problem Statement

Security checks for symlink rejection and ownership validation are implemented but not covered by tests.

## Findings

- Security checks are in `ensureSecureDirectory()` and `assertNotSymlink()`.
- Existing tests validate normal read/write/corruption/prune only.
- Location: `packages/claude-hooks/hooks/dedup-store.ts` and `dedup-store.test.ts`.

## Proposed Solutions

### Option 1: Add unit tests for symlink/uid guardrails (Recommended)

**Approach:** Add tests that create symlinked cache file/dir and assert rejection.

**Pros:** Verifies high-value security controls.  
**Cons:** Some tests may need platform guards.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add one integration security smoke script

**Approach:** End-to-end invocation with hostile tempdir setup.

**Pros:** Realistic behavior validation.  
**Cons:** Higher complexity for CI portability.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/dedup-store.test.ts`

## Acceptance Criteria

- [ ] Symlinked cache directory is rejected.
- [ ] Symlinked cache file is rejected.
- [ ] UID mismatch path is covered where supported.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Captured missing test coverage for filesystem hardening logic.  
**Learnings:** Security assumptions need explicit regression tests.

