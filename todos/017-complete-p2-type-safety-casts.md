---
status: complete
priority: p2
issue_id: "017"
tags: [code-review, quality, type-safety]
dependencies: []
---

# Resolve `as unknown as Record<string, unknown>` type casts and untyped JSON.parse

## Problem Statement

biome-runner and bun-runner use 6 instances of `as unknown as Record<string, unknown>` for `structuredContent`. tsc-runner does NOT need this cast -- it passes the output directly. Additionally, biome-runner uses untyped `JSON.parse()` 4 times for Biome's JSON reporter output.

## Findings

1. **TypeScript reviewer:** tsc-runner passes output without cast (line 384), proving the cast may be unnecessary in the other runners. Inconsistency suggests the cast can be dropped.
2. **TypeScript reviewer:** 4 untyped `JSON.parse()` calls in biome-runner (lines 169, 320, 327, 360) return `any`. Should have type annotations or Zod validation.
3. **Pattern recognition:** The cast is applied uniformly in biome/bun but absent from tsc, creating an unexplained divergence.

## Proposed Solutions

### Option A: Remove casts, align with tsc-runner pattern (Recommended)

1. Test whether biome-runner and bun-runner can pass `structuredContent` without the double cast (like tsc-runner does)
2. Add type annotations to `JSON.parse()` calls in biome-runner: `as BiomeReport` or use `.safeParse()` with a Zod schema

- **Effort:** Small
- **Risk:** Low

### Option B: Add Zod validation for biome JSON output

Define a `biomeReportSchema` and use `.safeParse()` for defense against unexpected format changes from biome version upgrades.

- **Effort:** Medium
- **Risk:** Low

## Technical Details

**Affected files:**
- `packages/biome-runner/mcp/index.ts` lines 169, 320, 327, 360, 492, 538, 582
- `packages/bun-runner/mcp/index.ts` lines 434, 481, 523

## Acceptance Criteria

- [ ] No `as unknown as Record<string, unknown>` casts remain (or documented why needed)
- [ ] `JSON.parse()` calls have type annotations or Zod validation
- [ ] All tests pass after changes

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | TypeScript + pattern reviewers |
