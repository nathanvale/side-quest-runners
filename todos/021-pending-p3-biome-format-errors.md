---
status: complete
priority: p3
issue_id: "021"
tags: [code-review, quality, biome]
dependencies: []
---

# Fix 11 Biome lint/format errors in unstaged files

## Problem Statement

Biome CI hook reports 11 errors across the unstaged changes: import ordering issues in biome-runner and bun-runner `index.ts`, and formatting issues across all runner files and 2 report JSON files.

## Findings

1. **Biome CI hook:** 11 errors -- 2 import ordering, 9 formatting
2. Report JSON files in `reports/` should likely be gitignored or excluded from biome

## Proposed Solutions

### Option A: Run biome fix and stage (Recommended)

```bash
bunx @biomejs/biome check --write packages/ scripts/
```

For report JSON files, either gitignore `reports/` or exclude from biome config.

- **Effort:** Trivial
- **Risk:** None

## Acceptance Criteria

- [ ] Biome CI hook passes with 0 errors
- [ ] Import ordering fixed in biome-runner and bun-runner
- [ ] All runner files properly formatted

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Biome CI hook |
