---
status: pending
priority: p1
issue_id: "013"
tags: [code-review, performance, tsc-runner]
dependencies: []
---

# Replace synchronous fs calls with async in tsc-runner

## Problem Statement

`findNearestTsConfig` and `resolveWorkdir` use `fs.existsSync()` and `fs.statSync()` in the hot path. These block the event loop and serialize concurrent tool calls -- defeating the promise-coalescing pattern on `getGitRoot()`.

4-6 synchronous filesystem operations per tool call, each potentially blocking 1-10ms under I/O contention.

## Findings

1. **Performance oracle (CRITICAL-3):** Sync calls block event loop, serialize concurrent requests
2. **TypeScript reviewer:** tsc-runner is the only runner importing `import fs from 'node:fs'` (sync API); biome and bun runners use only `node:fs/promises`

## Proposed Solutions

### Option A: Replace with async equivalents (Recommended)

Replace `fs.existsSync` with `access()` from `node:fs/promises`, and `fs.statSync` with `stat()`:

```typescript
import { access, stat } from 'node:fs/promises'

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await access(filePath)
        return true
    } catch {
        return false
    }
}
```

- **Pros:** Unblocks concurrent tool calls, consistent with other runners
- **Cons:** Slightly more verbose, requires async propagation through `findNearestTsConfig` and `resolveWorkdir` (both already async)
- **Effort:** Small
- **Risk:** Low

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts` lines 208, 237, 241, 246

## Acceptance Criteria

- [ ] No `fs.existsSync` or `fs.statSync` calls remain in tsc-runner
- [ ] `findNearestTsConfig` and `resolveWorkdir` use async fs operations
- [ ] `import fs from 'node:fs'` removed (only `node:fs/promises` used)
- [ ] Existing tests pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Performance oracle flagged CRITICAL-3 |
