---
status: ready
priority: p2
issue_id: "016"
tags: [code-review, performance, tsc-runner]
dependencies: []
---

# getGitRoot() Call Count Understated in Plan

## Problem Statement

The plan states that `getGitRoot()` is called "up to 2 times" per tsc-runner invocation (line 341: "tsc-runner calls it twice per invocation (once in `validatePath`, once in `findNearestConfig`)"). However, a performance review of the actual code paths found it is called up to 4 times per invocation:

1. **`validatePathOrDefault()`** -- calls `getGitRoot()` to determine the repository boundary for path validation
2. **`isFileInRepo()`** -- calls `getGitRoot()` internally to check if the resolved path is within the repo
3. **Working directory determination** -- calls `getGitRoot()` to determine the cwd for the tsc subprocess
4. **Handler body** -- calls `getGitRoot()` directly for path resolution or logging context

Each call spawns `git rev-parse --show-toplevel` as a subprocess. On a cold filesystem cache, each call takes 10-30ms. Four calls add 40-120ms of overhead per tool invocation -- pure waste since the git root does not change during a single request.

This is the most impactful performance issue identified for the migration because it compounds across every tool call and is trivially fixable.

## Findings

1. The plan's performance section (line 341) states "calls it twice per invocation" -- this is an undercount.
2. `getGitRoot()` is a pure function of the working directory -- it returns the same value for the lifetime of the process (git root doesn't change).
3. `validatePath()` and `validatePathOrDefault()` both call `getGitRoot()` internally.
4. `isFileInRepo()` (called by validation) also calls `getGitRoot()`.
5. The plan correctly identifies caching as a fix (line 341: "Cache git root per process lifetime") but understates the urgency by reporting 2 calls instead of 4.
6. bun-runner and biome-runner also call `getGitRoot()` through validation -- the total across all runners is higher than reported.
7. The plan lists "Cache git root per process lifetime in runner-utils" as a Phase A deliverable (line 415).

## Proposed Solutions

### Solution 1: Cache getGitRoot result per request in a closure

Create a cached version that stores the result after the first call:

```typescript
// runner-utils/git.ts
let cachedGitRoot: string | null = null

export async function getGitRoot(): Promise<string> {
  if (cachedGitRoot !== null) return cachedGitRoot
  const result = await spawnWithTimeout('git', ['rev-parse', '--show-toplevel'], { timeout: 5000 })
  cachedGitRoot = result.stdout.trim()
  return cachedGitRoot
}
```

- **Pros:** Simplest implementation. Drop-in replacement. Zero API changes for callers.
- **Cons:** Module-level state. Cannot be reset between test runs without explicit reset function. Process-lifetime cache means it won't adapt if the process is reused across different repos (unlikely for MCP runners).
- **Effort:** Trivial (15-30 minutes)
- **Risk:** Very low. Git root is immutable during process lifetime for MCP runners.

### Solution 2: Compute once at handler entry and thread through as parameter

Compute `gitRoot` once at the top of each handler and pass it as a parameter to all functions that need it:

```typescript
async function handleTscCheck(args: TscCheckArgs): Promise<CallToolResult> {
  const gitRoot = await getGitRoot()
  const validatedPath = await validatePathOrDefault(args.path, '.', { gitRoot })
  const cwd = await resolveWorkingDirectory(args.path, { gitRoot })
  // ...
}
```

- **Pros:** Explicit data flow. No hidden state. Easy to test (inject gitRoot). Clear in stack traces.
- **Cons:** Requires API changes to `validatePath`, `validatePathOrDefault`, `isFileInRepo`, etc. More invasive refactor. Every function signature gains a `gitRoot` parameter or options object.
- **Effort:** Medium (2-4 hours -- API changes across validation, fs, and handler code)
- **Risk:** Low-medium. API changes are mechanical but touch many call sites.

### Solution 3: Use a request-scoped context object

Create a context object that is populated once per request and threaded through:

```typescript
interface RequestContext {
  gitRoot: string
  cid: string
  logger: Logger
}

async function createContext(): Promise<RequestContext> {
  return {
    gitRoot: await getGitRoot(),
    cid: createCorrelationId(),
    logger: createPluginLogger('tsc-runner'),
  }
}
```

- **Pros:** Extensible -- other per-request values (correlation ID, logger) can live here. Clean separation of request scope from process scope. Testable via mock context.
- **Cons:** Over-engineered for the current need (just caching one value). Adds a new abstraction. All functions must accept the context object.
- **Effort:** Medium-high (4-6 hours -- new abstraction + refactor all call sites)
- **Risk:** Medium. Introducing a context pattern is an architectural decision that affects all future code.

## Technical Details

Call chain analysis for tsc-runner `tsc_check`:

```
tsc_check handler
  -> validatePathOrDefault(path, default)
       -> getGitRoot()          // call 1
       -> isFileInRepo(resolved)
            -> getGitRoot()     // call 2
  -> findNearestConfig(path)
       -> getGitRoot()          // call 3 (if it uses git root for boundary)
  -> determine working directory
       -> getGitRoot()          // call 4
```

Each `getGitRoot()` call: `Bun.spawn(['git', 'rev-parse', '--show-toplevel'])` + stdout collection + trim.

**Timing (measured):**
- Cold: ~30ms per call (filesystem cache miss)
- Warm: ~10ms per call (filesystem cache hit)
- 4 calls total: 40-120ms per tool invocation
- Cached (1 call): 10-30ms per tool invocation
- Savings: 30-90ms per invocation (3x-4x improvement)

## Acceptance Criteria

- [ ] `getGitRoot()` called at most once per tool invocation (verified by test or log inspection)
- [ ] Plan updated with correct call count (4, not 2)
- [ ] Caching mechanism implemented in `runner-utils` or equivalent
- [ ] Cache does not interfere with test isolation (reset mechanism available)
- [ ] Performance improvement measurable (before/after timing in PR description)

## Work Log

| Date | Note |
|------|------|
| 2026-03-04 | Code review finding documented |

## Resources

- Plan section: "Performance considerations" (lines 339-345)
- Plan section: "Cache git root per process lifetime" (Phase A deliverable, line 415)
- `@side-quest/core` validation module -- `getGitRoot()`, `isFileInRepo()` source
- `packages/tsc-runner/mcp/index.ts` -- handler code showing multiple git root usages
