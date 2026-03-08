---
status: complete
priority: p3
issue_id: "042"
tags: [code-review, schema, hooks]
dependencies: []
---

# Hook Output Schema Allows `hookSpecificOutput` Without `hookEventName`

## Problem Statement

Output validation allows `hookSpecificOutput` object without `hookEventName`, which can produce ambiguous or contract-fragile responses.

## Findings

- Location: `packages/claude-hooks/hooks/claude-schema.ts`.
- `hookEventName` is optional in `hookSpecificOutput`.
- Most hook-specific behaviors expect explicit event binding.

## Proposed Solutions

### Option 1: Require `hookEventName` whenever `hookSpecificOutput` is present (Recommended)
**Approach:** Add schema refinement to enforce it.
**Pros:** Stronger contract safety.  
**Cons:** Slightly stricter payload requirements.  
**Effort:** Small  
**Risk:** Low

### Option 2: Keep optional but enforce via helper constructors only
**Approach:** Prevent raw manual output creation outside helper paths.
**Pros:** Flexible schema.  
**Cons:** Easier to regress with ad hoc objects.  
**Effort:** Small  
**Risk:** Medium

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/claude-schema.ts`
- Affected: `packages/claude-hooks/hooks/claude-response.ts`

## Acceptance Criteria
- [ ] Invalid outputs with hookSpecificOutput missing hookEventName are rejected.
- [ ] Existing valid output paths continue to pass.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged output contract looseness.

