---
status: complete
priority: p2
issue_id: "031"
tags: [code-review, reliability, hooks]
dependencies: []
---

# `mcpWasError` Detection Is Too Narrow

## Problem Statement

`readMcpErrorFlag()` only checks `tool_response.isError === true`, which can miss alternate error envelope shapes and misclassify success/failure divergence logic.

## Findings

- Location: `packages/claude-hooks/hooks/posttool.ts`.
- Divergence guard in `PostToolUseFailure` depends on accurate `mcpWasError`.
- Narrow detection can incorrectly emit pointer vs fallback.

## Proposed Solutions

### Option 1: Add robust error-shape detection (Recommended)

**Approach:** Recognize `isError`, known `error` object shapes, and failure code envelopes.

**Pros:** Better correctness for cross-runner variations.  
**Cons:** Slightly more parsing logic.  
**Effort:** Small  
**Risk:** Low

### Option 2: Persist raw result metadata and decide later

**Approach:** Save a minimal normalized outcome enum (`success|error|unknown`) in record.

**Pros:** Cleaner policy inputs.  
**Cons:** Requires record/schema update.  
**Effort:** Medium  
**Risk:** Medium

## Recommended Action

## Technical Details

- Affected: `packages/claude-hooks/hooks/posttool.ts`
- Affected: `packages/claude-hooks/hooks/posttool-failure.ts`

## Acceptance Criteria

- [ ] Error detection covers known runner failure envelopes.
- [ ] Tests validate decision behavior for success/error/unknown responses.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Logged error-classification gap and test implications.  
**Learnings:** Divergence protection is only as strong as `mcpWasError` fidelity.

