---
status: complete
priority: p2
issue_id: "032"
tags: [code-review, testing, hooks, reliability]
dependencies: []
---

# Missing Divergence Regression Tests In `PostToolUseFailure`

## Problem Statement

Current tests do not verify the core safety rule: never suppress a `PostToolUseFailure` when a success-path MCP response was previously seen.

## Findings

- `posttool-failure.test.ts` only checks generic valid output.
- No test seeds store state with `mcpSeen=true, mcpWasError=false` and asserts fallback failure details.
- Location: `packages/claude-hooks/hooks/posttool-failure.test.ts`.

## Proposed Solutions

### Option 1: Add direct handler unit tests (Recommended)

**Approach:** Mock store read/write and assert decision outputs for divergence/non-divergence paths.

**Pros:** Fast and deterministic.  
**Cons:** Requires test seam for store dependency injection or fixture setup.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add integration test via CLI flow

**Approach:** Run posttool then posttool-failure with same key and validate output context.

**Pros:** End-to-end confidence.  
**Cons:** Slower and more brittle.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/posttool-failure.test.ts`
- Optional: `packages/claude-hooks/hooks/index.test.ts`

## Acceptance Criteria

- [ ] Divergence path is explicitly tested and passes.
- [ ] Non-divergence path behavior remains unchanged.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Identified missing test coverage on highest-risk decision branch.  
**Learnings:** Single smoke assertion is insufficient for this contract rule.

