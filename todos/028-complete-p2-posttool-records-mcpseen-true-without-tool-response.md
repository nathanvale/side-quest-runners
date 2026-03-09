---
status: complete
priority: p2
issue_id: "028"
tags: [code-review, reliability, hooks, dedup]
dependencies: []
---

# PostToolUse Persists `mcpSeen=true` Without `tool_response`

## Problem Statement

`handlePostToolUse` persists dedup state with `mcpSeen: true` even when the hook payload has no `tool_response`.
This can create a false dedup signal for later events keyed by fallback target (when `tool_use_id` is missing), causing pointer output to be emitted even though no MCP response was actually observed.

## Findings

- `packages/claude-hooks/hooks/posttool.ts:33-47` computes `hasToolResponse` but unconditionally writes `mcpSeen: true`.
- Runtime repro confirms persisted state includes `mcpSeen: true` with missing `tool_response` input.
- Existing tests (`packages/claude-hooks/hooks/index.test.ts`) validate output text for missing `tool_response`, but do not validate persisted dedup state fields.

## Proposed Solutions

### Option 1: Gate `mcpSeen` On Actual Response (Recommended)

**Approach:** Set `mcpSeen: hasToolResponse` in persisted record.

**Pros:**
- Minimal code change.
- Aligns persisted state with observed evidence.
- Prevents false-positive pointer behavior in fallback-key scenarios.

**Cons:**
- Slight behavior change for malformed/legacy hook payloads.

**Effort:** Small

**Risk:** Low

---

### Option 2: Keep Current State But Ignore `mcpSeen` For No-`tool_use_id` Keys

**Approach:** Add policy logic to reject pointer decisions when key is fallback-based and no known response marker exists.

**Pros:**
- Preserves current write behavior.

**Cons:**
- More complex and indirect.
- Harder to reason about than writing correct state.

**Effort:** Medium

**Risk:** Medium

## Recommended Action

## Technical Details

**Affected files:**
- `packages/claude-hooks/hooks/posttool.ts`
- `packages/claude-hooks/hooks/index.test.ts` (or a new posttool-focused test)

## Resources

- Plan reference: `docs/plans/2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md`

## Acceptance Criteria

- [ ] `PostToolUse` stores `mcpSeen=false` when `tool_response` is absent.
- [ ] A regression test asserts persisted record fields for missing-response input.
- [ ] Existing `claude-hooks` tests continue passing.

## Work Log

### 2026-03-07 - Review Finding Capture

**By:** Codex

**Actions:**
- Reviewed `PostToolUse` state write path.
- Reproduced behavior with a direct runtime probe and confirmed `mcpSeen=true` persisted without `tool_response`.

**Learnings:**
- Output behavior is currently correct for first invocation, but persisted state semantics are inconsistent and can affect subsequent dedup decisions.

## Notes

- This is a reliability correctness issue, not a security issue.
