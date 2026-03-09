---
status: complete
priority: p3
issue_id: "038"
tags: [code-review, testing, smoke, hooks]
dependencies: []
---

# Claude Hooks Smoke Test Does Not Assert Dedup Semantics

## Problem Statement

Smoke coverage for `claude-hooks` only checks envelope shape and event name, not pointer/fallback behavior or dedup metadata presence.

## Findings

- Smoke test parses stdout and asserts only `hookEventName`.
- It does not assert pointer message text, dedup key metadata, or fallback behavior.
- Location: `scripts/smoke/run-smoke.ts`.

## Proposed Solutions

### Option 1: Strengthen existing smoke assertions (Recommended)

**Approach:** Assert `additionalContext` contains expected pointer signature when `tool_response` exists.

**Pros:** Simple and high-value.  
**Cons:** Message assertions can be brittle if wording changes.  
**Effort:** Small  
**Risk:** Low

### Option 2: Add two-step smoke flow (pointer + fallback)

**Approach:** Execute one payload with response and one without; assert both branches.

**Pros:** Better behavior coverage.  
**Cons:** Slightly longer smoke runtime.  
**Effort:** Medium  
**Risk:** Low

## Recommended Action

## Technical Details

- Affected: `scripts/smoke/run-smoke.ts`

## Acceptance Criteria

- [ ] Smoke validates pointer branch content.
- [ ] Smoke validates fallback branch content.
- [ ] Smoke remains stable in CI.

## Work Log

### 2026-03-07 - Review capture

**By:** Codex  
**Actions:** Logged smoke assertion gap for hook semantics.  
**Learnings:** Envelope-only smoke checks miss functional regressions.

