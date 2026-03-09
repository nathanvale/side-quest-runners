---
status: complete
priority: p3
issue_id: "049"
tags: [code-review, compatibility, dedup, hooks]
dependencies: []
---

# `normalizeTarget()` Rejects Unicode Paths And Collapses To `.`

## Problem Statement

Target normalization regex allows only ASCII-like characters. Valid Unicode paths/patterns are downgraded to `.`, increasing fallback key collisions.

## Findings

- Location: `packages/claude-hooks/hooks/dedup-key.ts`.
- Regex gate rejects non-ASCII path text.
- Rejected values fallback to `.` and reduce key uniqueness.

## Proposed Solutions

### Option 1: Relax allowlist to support safe Unicode path chars (Recommended)
**Approach:** Use a stricter control-char reject strategy rather than narrow positive ASCII regex.
**Pros:** Better cross-platform compatibility and lower collision risk.  
**Cons:** Slightly broader accepted input set.  
**Effort:** Small  
**Risk:** Low

### Option 2: Keep regex but hash raw target for fallback uniqueness
**Approach:** If regex fails, keep a hashed surrogate instead of `.`.
**Pros:** Maintains strict visible string policy with uniqueness retained.  
**Cons:** Harder to debug by eye.  
**Effort:** Small  
**Risk:** Low

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/dedup-key.ts`
- Add tests in `packages/claude-hooks/hooks/dedup-key.test.ts`

## Acceptance Criteria
- [ ] Unicode-safe targets do not collapse to `.`.
- [ ] Fallback keys remain collision-resistant for rejected/edge targets.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged compatibility and dedup-entropy issue in target normalization.

