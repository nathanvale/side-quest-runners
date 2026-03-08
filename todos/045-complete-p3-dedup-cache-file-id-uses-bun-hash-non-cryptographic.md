---
status: complete
priority: p3
issue_id: "045"
tags: [code-review, reliability, hooks, storage]
dependencies: []
---

# Dedup Cache File ID Uses `Bun.hash` Instead Of Stable SHA-256

## Problem Statement

Cache file naming uses `Bun.hash(projectRoot)`, which is non-cryptographic and less explicit than stable SHA-256 for persistence identifiers.

## Findings

- Location: `packages/claude-hooks/hooks/dedup-store.ts`.
- Plan direction emphasized stable SHA-256 identifiers for keys.
- Hash collisions are unlikely but not impossible with non-cryptographic hash.

## Proposed Solutions

### Option 1: Replace file id with SHA-256(projectRoot) (Recommended)
**Approach:** Use Node crypto hash and hex output.
**Pros:** Deterministic, explicit, collision-resistant.  
**Cons:** Tiny compute cost increase.  
**Effort:** Small  
**Risk:** Low

### Option 2: Keep Bun.hash and prefix with uid + escaped path
**Approach:** Add extra entropy with path-derived suffix.
**Pros:** Reduces collision likelihood.  
**Cons:** More awkward filenames and still non-crypto base.  
**Effort:** Small  
**Risk:** Medium

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/dedup-store.ts`

## Acceptance Criteria
- [ ] Cache path generation uses stable cryptographic hash.
- [ ] Existing read/write behavior remains compatible or has migration fallback.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged persistence-id robustness improvement.

