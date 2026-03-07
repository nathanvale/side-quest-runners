---
status: complete
priority: p2
issue_id: "018"
tags: [code-review, quality, consistency]
dependencies: []
---

# Normalize spawn helper naming and test style across runners

## Problem Statement

Three naming/style inconsistencies across the 3 runners:

1. **Spawn helper name:** `spawnWithTimeout` (tsc + bun) vs `spawnAndCollect` (biome) -- same behavior, different names
2. **Spawn helper signature:** biome uses options-bag timeout (`options.timeoutMs`), others use positional parameter
3. **Test style:** tsc + biome use `test()`, bun uses `it()` -- cosmetic but noticeable
4. **Parameter naming:** `cmd` (tsc + bun) vs `command` (biome)
5. **Timeout constant naming:** `TSC_TIMEOUT_MS` / `BIOME_TIMEOUT_MS` / `TEST_TIMEOUT_MS` -- inconsistent prefix

## Findings

1. **Pattern recognition:** Detailed comparison showed the divergences
2. **TypeScript reviewer:** Inconsistent naming increases cognitive load during maintenance
3. **Simplicity reviewer:** Confirmed same behavior, different names

## Proposed Solutions

### Option A: Standardize names and signatures (Recommended)

- Rename biome-runner's `spawnAndCollect` to `spawnWithTimeout`
- Align signature across all 3 (prefer positional timeout -- simpler, used 2-of-3)
- Pick `test()` for all test files (used 2-of-3)
- Use `cmd` parameter name everywhere

- **Effort:** Small
- **Risk:** Low

## Acceptance Criteria

- [ ] All 3 runners use `spawnWithTimeout` with consistent signature
- [ ] All test files use `test()` (not `it()`)
- [ ] Parameter names consistent (`cmd`, not `command`)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Pattern + TS reviewers |
