---
status: complete
priority: p2
issue_id: "030"
tags: [code-review, reliability, hooks, dedup]
dependencies: []
---

# Fallback Dedup Key Collision When `tool_use_id` Is Missing

## Problem Statement

Fallback dedup keys can collide too broadly when `tool_use_id` is absent, causing unrelated events to dedup against each other.

## Findings

- `normalizeTarget()` frequently collapses to `.` for sparse or unrecognized tool input.
- Key format then becomes `<runner>|<operation>|.` for many calls.
- This can produce false positive dedup hits.
- Location: `packages/claude-hooks/hooks/dedup-key.ts`.

## Proposed Solutions

### Option 1: Expand fallback key entropy (Recommended)

**Approach:** Include stable fields like `cwd`, normalized matcher inputs, and a bounded hash of `tool_input` shape.

**Pros:** Lower collision risk with minimal behavior change.  
**Cons:** Slightly longer key logic.  
**Effort:** Small  
**Risk:** Low

### Option 2: Disable dedup without `tool_use_id`

**Approach:** Emit fallback only when `tool_use_id` is missing.

**Pros:** Eliminates false dedup from fallback keys.  
**Cons:** Reduces dedup effectiveness on older/partial payloads.  
**Effort:** Small  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/dedup-key.ts`
- Affected: `packages/claude-hooks/hooks/claude-mapper.ts`

## Resources

- Plan: `docs/plans/2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md`

## Acceptance Criteria

- [ ] Fallback dedup keys are unique for common tool input variants.
- [ ] Regression tests cover missing `tool_use_id` scenarios.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Recorded collision risk and mitigation options.  
**Learnings:** Fallback dedup safety depends on key entropy.

