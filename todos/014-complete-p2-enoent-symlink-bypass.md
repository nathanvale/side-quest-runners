---
status: complete
priority: p2
issue_id: "014"
tags: [code-review, security, path-validation]
dependencies: []
---

# ENOENT fallback bypasses intermediate symlink resolution

## Problem Statement

When `realpath()` fails with ENOENT (file does not exist), `validatePath` falls back to `path.resolve()` which does NOT resolve symlinks on intermediate directory components. A path like `/repo/symlink-dir/nonexistent` where `symlink-dir` points outside the repo would pass the boundary check because `realpath` fails on the full path and `path.resolve` doesn't follow the symlink.

## Findings

1. **Security sentinel (Finding 3, MEDIUM):** If an attacker crafts a non-existent path where an intermediate directory component is a symlink to outside the repo, `realpath` fails with ENOENT, and the `path.resolve` fallback won't resolve the intermediate symlink.
2. **Pattern recognition:** This ENOENT fallback is identical across all 3 runners.

## Proposed Solutions

### Option A: Walk up to nearest existing ancestor and realpath that (Recommended)

When ENOENT occurs, walk up path components, `realpath()` the nearest existing ancestor, then append remaining components:

```typescript
if (err.code === 'ENOENT') {
    let dir = path.dirname(resolvedPath)
    while (dir !== path.dirname(dir)) {
        try {
            const realDir = await realpath(dir)
            realInputPath = path.join(realDir, path.relative(dir, resolvedPath))
            break
        } catch {
            dir = path.dirname(dir)
        }
    }
}
```

- **Pros:** Catches intermediate symlink escapes, closes the gap properly
- **Cons:** More filesystem calls on ENOENT paths (uncommon case)
- **Effort:** Small
- **Risk:** Low

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts` lines 133-138
- `packages/biome-runner/mcp/index.ts` lines 137-142
- `packages/bun-runner/mcp/index.ts` lines 108-116

## Acceptance Criteria

- [ ] ENOENT fallback resolves intermediate symlink components
- [ ] Test: symlink directory pointing outside repo with non-existent child path is rejected
- [ ] All 3 runners updated consistently

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Security sentinel Finding 3 |
