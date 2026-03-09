---
status: complete
priority: p3
issue_id: "041"
tags: [code-review, schema, hooks]
dependencies: []
---

# Claude Input Schema Does Not Strip Unknown Fields

## Problem Statement

Hook input parser uses `.passthrough()` and returns unknown fields to downstream code, increasing accidental coupling and attack surface.

## Findings

- Location: `packages/claude-hooks/hooks/claude-schema.ts`.
- Parsed object is forwarded with unknown keys preserved.
- Plan guidance expected passthrough for compatibility plus strip before core.

## Proposed Solutions

### Option 1: Add explicit sanitize step before core handlers (Recommended)
**Approach:** Parse with passthrough, then map into a strict internal shape.
**Pros:** Forward-compatible input + minimal trusted internal contract.  
**Cons:** Small mapping boilerplate.  
**Effort:** Small  
**Risk:** Low

### Option 2: Switch schema to `.strict()` and whitelist only known fields
**Approach:** Reject unknown payload fields.
**Pros:** Strong strictness.  
**Cons:** Less forward compatibility with Claude contract evolution.  
**Effort:** Small  
**Risk:** Medium

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/claude-schema.ts`
- Optional: `packages/claude-hooks/hooks/claude-mapper.ts`

## Acceptance Criteria
- [ ] Unknown input fields are not leaked into internal core processing.
- [ ] Contract-forward-compatibility remains preserved.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged schema hygiene gap against stated architecture guidance.

