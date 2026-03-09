---
status: complete
priority: p3
issue_id: "039"
tags: [code-review, testing, hooks, dedup]
dependencies: []
---

# Dedup Policy Missing TTL Boundary Regression Tests

## Problem Statement

Dedup policy tests do not explicitly verify boundary behavior at TTL edges (`== ttl`, `> ttl`, negative/clock-skew style deltas).

## Findings

- `dedup-policy.test.ts` covers basic hit/miss/divergence paths.
- TTL edge conditions are not explicitly asserted.
- Location: `packages/claude-hooks/hooks/dedup-policy.test.ts`.

## Proposed Solutions

### Option 1: Add focused TTL boundary tests (Recommended)

**Approach:** Add tests for exact-boundary, just-expired, and stale record behavior.

**Pros:** Prevents subtle regressions in time-based dedup logic.  
**Cons:** None meaningful.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add property-style randomized timing tests

**Approach:** Generate timing scenarios and assert monotonic policy behavior.

**Pros:** Broader confidence.  
**Cons:** More complex and potentially flaky if not deterministic.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/dedup-policy.test.ts`

## Acceptance Criteria

- [ ] Exact TTL boundary behavior is explicitly tested.
- [ ] Expired record behavior is explicitly tested.
- [ ] Tests remain deterministic.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Added TTL boundary test gap from policy review.  
**Learnings:** Time-window bugs usually hide at edges, not happy path.

