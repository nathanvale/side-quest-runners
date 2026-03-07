---
status: complete
priority: p2
issue_id: "026"
tags: [code-review, hooks, token-efficiency, reliability]
dependencies: []
---

# PostToolUse First Run Does Not Emit Dedup Pointer

## Problem Statement

The new hook dedup flow only emits a pointer on the second identical invocation, not on the first `PostToolUse` event. This leaves hook + MCP duplication in the highest-frequency path (single tool invocation), which undercuts the branch goal of immediate context reduction.

## Findings

- `decideDedupAction` requires an existing `mcpSeen` record before returning `action: 'pointer'` in [dedup-policy.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/dedup-policy.ts:24).
- On first invocation, `handlePostToolUse` reads state before writing, so `existing` is missing and it returns fallback summary in [posttool.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/posttool.ts:35).
- Reproduction with dedup enabled:
  - First call output: `"Hook summary: tsc/typecheck errors=0"`
  - Second call with same `tool_use_id`: `"Dedup hit: ... Use MCP output above."`
- The plan targets pointer mode when MCP output is already available for the same tool event, so current behavior is misaligned with spec intent in [2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md](/Users/nathanvale/code/side-quest-runners/docs/plans/2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md).

## Proposed Solutions

### Option 1: Pointer-by-default for valid PostToolUse events

**Approach:** For `PostToolUse`, return pointer whenever runner mapping succeeds and `tool_response` exists; reserve fallback for unmapped tools or cache-write failures.

**Pros:**
- Aligns with plan intent
- Maximizes token savings immediately

**Cons:**
- Less inline fallback detail on first event

**Effort:** 1-2 hours

**Risk:** Low

---

### Option 2: Record-before-decision flow

**Approach:** Write/update dedup record first, then evaluate pointer/fallback with fresh state in the same invocation.

**Pros:**
- Preserves current policy shape
- Minimal conceptual shift

**Cons:**
- More brittle ordering semantics
- Still indirect compared to explicit pointer rule

**Effort:** 2-3 hours

**Risk:** Medium

## Recommended Action


## Technical Details

**Affected files:**
- [posttool.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/posttool.ts)
- [dedup-policy.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/dedup-policy.ts)
- [index.test.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/index.test.ts)

**Related components:**
- Hook dedup policy
- Hook/MCP context compaction pipeline

**Database changes (if any):**
- No

## Resources

- Plan: [2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md](/Users/nathanvale/code/side-quest-runners/docs/plans/2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md)
- Similar pattern: [mcp-tool-discoverability-ab-benchmark.md](/Users/nathanvale/code/side-quest-runners/docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md)

## Acceptance Criteria

- [x] First `PostToolUse` with valid mapped runner returns pointer-style `additionalContext`
- [x] Pointer behavior remains safe for `PostToolUseFailure` divergence cases
- [x] Unit tests cover first-invocation pointer path and fallback-only edge paths
- [x] Smoke test still passes

## Work Log

### 2026-03-07 - Initial Discovery

**By:** Codex

**Actions:**
- Reviewed posttool/dedup policy control flow
- Reproduced first-run fallback then second-run pointer behavior locally
- Mapped mismatch to plan contract text

**Learnings:**
- The current dedup behavior optimizes repeated identical events, not the first event where most duplication occurs

## Notes

- This is a behavior-to-spec mismatch, not a crash bug, but it directly impacts token-efficiency ROI for this branch.

### 2026-03-07 - Resolved

**By:** Claude Code

**Actions:**
- Removed `decideDedupAction` call from PostToolUse path in `posttool.ts`
- For mapped tools with `tool_response`, always return pointer on every invocation (including first)
- Dedup record still written for future PostToolUseFailure divergence detection
- Fallback summary only used when `tool_response` is missing or on cache write errors
- Added 2 new tests: first-invocation pointer path and fallback when tool_response missing
- All 7 tests pass

**Learnings:**
- PostToolUse always fires after MCP tool returns, so MCP output is always in context -- no reason to repeat a summary
