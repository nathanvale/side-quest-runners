---
title: "Phase A: SDK Migration -- Drop @side-quest/core for Raw MCP SDK"
type: feat
status: completed
date: 2026-03-04
deepened: 2026-03-04
priority: p1
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
decision: docs/research/2026-03-04-phase-0-architecture-gate-decision.md
depends_on: []
absorbs: [003, 014, 015, 016, 020]
---

# Phase A: SDK Migration -- Drop @side-quest/core for Raw MCP SDK

## Enhancement Summary

**Deepened on:** 2026-03-04
**Sections enhanced:** 7
**Research agents used:** MCP SDK docs, validation hardening, getGitRoot caching, security sentinel, architecture strategist, performance oracle, code simplicity reviewer, learnings researcher

### Key Improvements
1. Security-hardened validator implementations with defense-in-depth (6 layers, OWASP-aligned)
2. Promise-coalescing getGitRoot cache pattern for safe concurrent access
3. Concrete SDK migration patterns with pitfall workarounds (structuredContent validation, error handling)
4. findNearestTsConfig must restore git-root boundary (regression from PoC)
5. Migration order recommendation: tsc -> biome -> bun (complexity sequencing)

### New Considerations Discovered
- SDK pitfall: structuredContent validation blocks error reporting -- fixed in 1.27.1 but defensive pattern needed
- SDK pitfall: thrown errors gobbled when outputSchema defined -- always return CallToolResult, never throw
- macOS `/var` -> `/private/var` symlink breaks boundary checks if both sides not realpath'd
- PoC's findNearestTsConfig walks to `/` unbounded -- must restore git-root boundary from core
- Biome-runner's spawnAndCollect has no timeout -- add during inline to prevent process hangs
- Re-run discoverability A/B benchmark after migration to verify tool routing held

---

## Overview

Migrate all 3 runners from `@side-quest/core` wrappers to direct `@modelcontextprotocol/sdk@^1.27.1` dependency. This is the foundation everything else builds on -- no contract, reliability, or observability work can land until runners own their MCP integration directly.

## Problem Statement

Phase 0 decided to drop `@side-quest/core` (see [decision memo](../research/2026-03-04-phase-0-architecture-gate-decision.md)). The raw SDK PoC at `packages/tsc-runner/mcp/raw-sdk-poc.ts` proves `registerTool()` works with `title`, `outputSchema`, annotations, and `structuredContent`. Now we need to apply that pattern to all 3 production runners and remove the core dependency.

## Proposed Solution

For each runner, replace core imports with raw SDK equivalents and inline the few utilities needed. The PoC is the reference implementation.

### Import Map

| Core Import | Raw SDK Replacement |
|---|---|
| `startServer, tool, z` from `@side-quest/core/mcp` | `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`, `z` from `zod` |
| `wrapToolHandler, ResponseFormat` from `@side-quest/core/mcp-response` | Direct `CallToolResult` returns -- handlers return `{ content, structuredContent, isError }` |
| `spawnWithTimeout` from `@side-quest/core/spawn` | Inline into each runner (already done in PoC) |
| `spawnAndCollect` from `@side-quest/core/spawn` | Inline into biome-runner (with timeout support added) |
| `findNearestConfig` from `@side-quest/core/fs` | Inline into tsc-runner (with git-root boundary restored) |
| `validatePathOrDefault, validatePath, validateShellSafePattern` from `@side-quest/core/validation` | Inline into each runner (with security hardening) |
| `createPluginLogger, createCorrelationId` from `@side-quest/core/logging` | Remove -- console.error for now, proper logging deferred to Phase D |

### Research Insights: Import Migration

**Best Practices (from SDK research):**
- Use `.js` extension in all SDK imports: `@modelcontextprotocol/sdk/server/mcp.js` (SDK uses wildcard exports map)
- Import `CallToolResult` as a type: `import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'`
- Stay on `zod@^3.25` -- Zod v4 is incompatible with MCP SDK (SDK #1429: `w._parse is not a function`)
- The SDK's `tool()` convenience method is deprecated since v1.25.0; `registerTool()` is the blessed replacement

**SDK Version Notes:**
- v1.25.0: Removed loose/passthrough types, strict schema compliance required, ES2020 target
- v1.26.0: Security fix for CVE-2026-25536 (cross-client data leak from transport reuse)
- v1.27.1: Current latest, includes structuredContent error handling fix (PR #655)
- v2 anticipated Q1 2026 with package restructuring (`@modelcontextprotocol/server`)

### Per-Runner Scope

**tsc-runner** (smallest surface, do first):
- Replace `tool()` + `wrapToolHandler()` with `server.registerTool()` returning `CallToolResult`
- Inline `spawnWithTimeout`, `findNearestConfig`, `resolveWorkdir`, `validatePathOrDefault`
- Promote PoC to production (replace `index.ts` with evolved `raw-sdk-poc.ts`)
- Add lifecycle: `stdin.resume()`, `transport.onclose`, SIGINT/SIGTERM handlers
- Update `package.json`: add `@modelcontextprotocol/sdk` + `zod`, remove `@side-quest/core`

**biome-runner** (medium surface, do second -- reinforces tsc-runner's `validatePathOrDefault` pattern):
- Replace `tool()` + `wrapToolHandler()` with `server.registerTool()`
- Inline `spawnAndCollect` (with timeout support), `validatePathOrDefault`
- Handlers return `CallToolResult` directly
- Update `package.json`

**bun-runner** (most complex, do third -- benefits from maximum migration experience):
- Replace `tool()` + `wrapToolHandler()` with `server.registerTool()`
- Inline `spawnWithTimeout`, `validatePath`, `validateShellSafePattern`
- Handlers return `CallToolResult` directly (throw removal already done in 002b)
- Update `package.json`

### Research Insights: Migration Order

**Architecture recommendation:** Swap bun-runner and biome-runner order.

Rationale:
- biome-runner uses `spawnAndCollect` (different spawn utility), giving coverage of both spawn patterns before the final runner
- biome-runner's validator is `validatePathOrDefault` (same as tsc-runner), so migration #2 reinforces migration #1's pattern
- bun-runner has the most complexity: 3 tools, `parse-utils.ts` dependency, `validatePath` + `validateShellSafePattern` (new validators)
- Saving the hardest runner for last means maximum migration experience when you hit the hardest case

### Research Insights: Per-Runner Migration Pattern

**Factory function pattern (required for testability):**

```typescript
// createXxxServer() returns McpServer (no transport wiring)
// Entry point calls factory + stdio. Tests call factory + InMemoryTransport.
export function createTscServer(): McpServer {
  const server = new McpServer({ name: 'tsc-runner', version })
  server.registerTool('tsc_check', { ... }, handler)
  return server
}

// Entry point
if (import.meta.main) {
  const server = createTscServer()
  const transport = new StdioServerTransport()
  transport.onclose = () => process.exit(0)
  await server.connect(transport)
  process.stdin.resume()
  // Signal handlers...
}
```

**Handler return pattern (always return, never throw):**

```typescript
async (args): Promise<CallToolResult> => {
  try {
    const output = await runTool(args)
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(output) }],
      structuredContent: output,
    }
  } catch (err) {
    // Return error WITHOUT structuredContent -- SDK skips validation for isError:true
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    }
  }
}
```

**Why never throw:** SDK Issue #699 -- thrown errors are gobbled when outputSchema is defined. The built-in try/catch loses structured error data. Always return `CallToolResult` with `isError: true` for known error paths.

**Lifecycle boilerplate (~15 lines per runner, intentionally not extracted):**

```typescript
const shutdown = async () => {
  if (shuttingDown) return    // Guard against double-invocation
  shuttingDown = true
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => { void shutdown() })
process.on('SIGTERM', () => { void shutdown() })
```

**Note:** `transport.onclose` is more reliable than signal handlers for clean exit -- Claude Code can have SIGINT propagation issues.

### Absorbed Scope

From **todo 014** (validatePathOrDefault bypass):
- Handle empty string input (apply default or reject)
- Handle null byte input (strip or reject)
- Add JSDoc and test vectors

From **todo 015** (zero integration test coverage):
- One InMemoryTransport integration test per runner
- Verify `tools/list` response (tool names, titles, annotations)
- Validate `structuredContent` against `outputSchema`
- Clear test diagnostics on failure

From **todo 016** (getGitRoot call count):
- Cache `getGitRoot()` result -- max 1 call per invocation
- Reset mechanism for test isolation

From **todo 020** (formatTestSummary default mismatch):
- Moot after handler rewrite -- handlers return `CallToolResult` directly, no format parameter needed

## Technical Considerations

- **Rollback**: Per-runner atomic commits. Dependency swap and code swap MUST be in the same commit. Run `bun run validate` after EACH runner migration before proceeding to the next.
- **SDK version**: Root `overrides` already pins `@modelcontextprotocol/sdk` to `1.27.1` workspace-wide. Verify single resolution with `bun pm ls @modelcontextprotocol/sdk`.
- **SDK known issues**: outputSchema validation crashes with `z.optional()` (SDK #1308), enforces `type: "object"` (SDK #1149). Canonical rule: **no `z.optional()` in `outputSchema` fields; allowed in `inputSchema`**.
- **Validation hardening**: Empty string and null byte vectors (from todo 014) must be addressed during validator porting.
- **Temporary degradation**: Between Phase A (removes `wrapToolHandler` error boundaries and logging) and Phase D (adds LogTape), handler errors will be less observable. Accepted as temporary debt.
- **Changesets**: Do not create version changesets until all 3 runners are migrated and validated.
- **PoC cleanup**: Add replacement integration tests first, verify they pass, THEN delete `raw-sdk-poc.ts` and `raw-sdk-poc.test.ts`.

### Research Insights: SDK Pitfalls

| Pitfall | Impact | Workaround |
|---------|--------|------------|
| structuredContent validation blocks error reporting (Issue #654) | SDK validates schema BEFORE checking isError, swallowing actual errors | Fixed in v1.27.1 (PR #655). Defensive: omit structuredContent when isError:true |
| Thrown errors gobbled with outputSchema (Issue #699) | Handler throws lose structured error data | Always return CallToolResult, never throw for known error paths |
| No compile-time type safety for structuredContent (Issue #669) | structuredContent shape not checked against outputSchema at build time | Use InMemoryTransport integration tests to catch mismatches at test time |
| Zod v4 incompatibility (SDK #1429) | Tools fail with `w._parse is not a function` | Stay on `zod@^3.25` (current: 3.25.76) |

### Research Insights: Security Hardening

**Critical findings from security review (must address in Phase A):**

1. **PoC has zero path validation** -- `resolveWorkdir(args.path)` called without `validatePathOrDefault`. Gate: no handler may call resolveWorkdir/spawnWithTimeout without validated input.

2. **findNearestTsConfig unbounded traversal** -- PoC walks to `/` looking for config files. Core version had git-root bounding (`while (currentDir.startsWith(gitRoot))`). The inlined version MUST restore this boundary.

3. **Null byte injection not blocked** -- Neither core nor PoC blocks null bytes. Add as first check in all validators: `if (inputPath.includes('\x00'))`.

4. **Flag injection via test pattern** -- `validateShellSafePattern` must reject leading dashes AND bun-runner spawn calls must use `--` separator. Defense in depth.

5. **macOS realpath requirement** -- Both sides of boundary check must use `realpath()`. macOS `/var` -> `/private/var` symlink breaks naive `startsWith` comparison.

6. **Input length limits** -- Add `.max(4096)` to all string parameters in Zod schemas.

**Validator implementation (defense-in-depth, 6 layers):**

```typescript
export async function validatePath(inputPath: string): Promise<string> {
  // Layer 1: Null byte rejection
  if (inputPath.includes('\x00')) {
    throw new Error('Path contains null byte')
  }
  // Layer 2: Control character rejection
  if (/[\x00-\x1f\x7f]/.test(inputPath)) {
    throw new Error(`Path contains control characters: ${JSON.stringify(inputPath)}`)
  }
  // Layer 3: Empty/whitespace rejection
  if (!inputPath || inputPath.trim() === '') {
    throw new Error('Path cannot be empty')
  }
  // Layer 4: path.resolve() -- canonicalizes ".." segments
  const resolvedPath = resolve(inputPath)
  // Layer 5: fs.realpath() -- resolves symlinks (CRITICAL: no fallback on failure)
  let realPath: string
  try {
    realPath = await realpath(resolvedPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      realPath = resolvedPath  // File doesn't exist yet, still check boundary
    } else {
      throw new Error(`Cannot resolve path: ${(err as Error).message}`)
    }
  }
  // Layer 6: Git repo boundary check
  const gitRoot = await getGitRoot()
  if (!realPath.startsWith(gitRoot + '/') && realPath !== gitRoot) {
    throw new Error(`Path outside repository: ${inputPath}`)
  }
  return realPath
}
```

**Shell-safe pattern validation (with flag injection defense):**

```typescript
export const SHELL_UNSAFE_CHARS = /[;&|<>`$\\\x00-\x1f\x7f]/

export function validateShellSafePattern(pattern: string): void {
  if (!pattern || pattern.trim() === '') {
    throw new Error('Pattern cannot be empty')
  }
  if (SHELL_UNSAFE_CHARS.test(pattern)) {
    throw new Error(`Pattern contains unsafe characters: ${JSON.stringify(pattern)}`)
  }
  // Reject leading dashes to prevent flag injection (e.g., --preload=./malicious.ts)
  if (/^-/.test(pattern)) {
    throw new Error('Pattern must not start with a dash (prevents flag injection)')
  }
}

// ALSO use -- separator at spawn site:
const args = ['bun', 'test', '--', userPattern]
```

**Test vectors (must-have edge cases):**

Path traversal: `../../../etc/passwd`, `/etc/passwd`, `src/\x00.ts`, `src/\n/index.ts`, `''`, `'   '`, `./symlink-to-outside`

Shell safety: `; rm -rf /`, `$(whoami)`, `--preload=./malicious.ts`, `-v`, `test\x00pattern`, `test\nmalicious`

### Research Insights: getGitRoot Caching

**Recommended pattern: promise coalescing (handles concurrent tool calls safely):**

```typescript
let _gitRootPromise: Promise<string> | null = null

/**
 * Get the root directory of the current git repository.
 * Cached for process lifetime -- git root is invariant once
 * the MCP server process starts. Uses promise coalescing so
 * concurrent tool calls share a single subprocess invocation.
 */
export function getGitRoot(): Promise<string> {
  if (_gitRootPromise !== null) return _gitRootPromise
  _gitRootPromise = resolveGitRoot()
  return _gitRootPromise
}

async function resolveGitRoot(): Promise<string> {
  const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
    stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error('Not inside a git repository')
  }
  // realpath the git root -- macOS /var -> /private/var symlink
  return realpath(stdout.trim())
}

/** Reset cache. Test-only -- never call in production. */
export function _resetGitRootCache(): void {
  _gitRootPromise = null
}
```

**Why promise coalescing over simple string cache:** If two concurrent tool calls hit `getGitRoot()` before the first resolves, they share the same promise. The subprocess runs exactly once. The simple `string | null` pattern would spawn two subprocesses in the race window.

**Caching granularity:** Once-per-process (not once-per-invocation). The git root cannot change during a process lifetime since the server runs from a fixed working directory. Saves ~5-15ms per tool call after the first. Over a session with 50+ tool calls, that is 250-750ms cumulative savings.

### Research Insights: Performance

**Cold-start improvement from dropping core: ~20-50ms.**

Core's import chain pulls in 40+ modules (oauth, compression, geo, html, streams, etc.) when runners only need ~4 small utilities. Module resolution + parsing of unused code adds measurable startup latency. For MCP servers started on-demand by Claude Code, this matters.

**Per-call improvement from getGitRoot caching: ~5-15ms per tool call** (eliminates redundant `git rev-parse` subprocess).

**Biome-runner timeout gap (critical):** The current `spawnAndCollect` calls in biome-runner have no timeout. `biome_lintFix` runs THREE sequential subprocesses. If biome hangs, the MCP server blocks indefinitely. When inlining, add timeout support (30s per command, 90s total for lintFix).

**Test organization:** Separate `tools/list` metadata tests (fast, ~10ms) from `callTool` execution tests (slow, 3-10s each) to keep the feedback loop fast during development.

### Research Insights: Architecture

**Inlining is correct (no shared package).** Utility overlap across runners is minimal. Only `spawnWithTimeout` is shared between 2 runners (tsc + bun), and it is a ~35-line function. Creating a shared package recreates the coupling problem being solved.

**`outputSchema` shape is provisional.** Phase B may change it. Do not document as stable API until Phase B completes.

**Version hardcoding in PoC (line 189):** `version: '1.0.2'` will mismatch package.json. Planned tech debt resolved in Phase B (version sync).

### Research Insights: Institutional Knowledge

**From discoverability A/B benchmark (docs/solutions/):** After migration, re-run `scripts/discoverability/eval-ab.ts` to verify tool routing quality held. Even if descriptions stay the same in code, the SDK change could affect how they are serialized/presented to clients. Gate: first-choice accuracy must not drop by more than 2%.

## Acceptance Criteria

### Core Migration
- [x] MCP SDK at `^1.27.1` as direct dependency in all 3 runners
- [x] `@side-quest/core` removed from all 3 `package.json` files
- [x] All core imports replaced with raw SDK equivalents or inlined utilities
- [x] `registerTool()` used with `title`, `outputSchema`, `annotations` for all 7 tools
- [x] Handlers return `CallToolResult` with `content` + `structuredContent`
- [x] Handlers always return (never throw) -- `isError: true` without `structuredContent` for errors
- [x] Lifecycle handling: `stdin.resume()`, `transport.onclose`, signal handlers with shutdown guard
- [x] Factory function pattern (`createXxxServer()`) for all 3 runners
- [x] Per-runner integration tests added and passing BEFORE PoC files are deleted
- [x] PoC files (`raw-sdk-poc.ts`, `raw-sdk-poc.test.ts`) deleted after replacement coverage confirmed
- [x] No `z.optional()` in any `outputSchema` field (allowed in `inputSchema`) (SDK #1308)
- [x] `bun run validate` passes after EACH runner migration (not just at the end)
- [ ] Dependency swap and code swap in same commit per runner

### Smoke Tests (per runner)
- [x] tsc-runner: InMemoryTransport test -- `tools/list` includes title/annotations/outputSchema, `callTool` returns structuredContent
- [x] bun-runner: InMemoryTransport test -- same verification
- [x] biome-runner: InMemoryTransport test -- same verification
- [x] All existing parser tests still pass (no import changes needed)

### Validation Hardening (from todo 014)
- [x] Null byte rejection as first check in all validators
- [x] Control character rejection (0x00-0x1F, 0x7F)
- [x] Empty/whitespace path rejection or default fallback
- [x] `fs.realpath()` for symlink resolution (no fallback on ELOOP failure)
- [x] Git-root boundary check with realpath on both sides (macOS safe)
- [x] `validateShellSafePattern` rejects leading dashes (flag injection)
- [x] bun-runner uses `--` separator before user patterns (defense in depth)
- [x] `.max(4096)` on all string parameters in Zod schemas
- [x] `findNearestTsConfig` bounded by git root (not unbounded to `/`)
- [x] JSDoc on all validators documenting security rationale
- [x] Test vectors for: null bytes, control chars, traversal, empty strings, symlinks, flag injection

### Performance (from todo 016)
- [x] `getGitRoot()` uses promise-coalescing cache (once per process)
- [x] `realpath()` applied to git root (macOS `/var` -> `/private/var`)
- [x] Cache reset mechanism for test isolation (`_resetGitRootCache`)
- [x] biome-runner `spawnAndCollect` inlined with timeout support

### Quality Gates
- [x] `bun run validate` passes
- [x] No `@side-quest/core` references remain in `packages/`
- [x] All existing tests pass, new integration tests pass, no critical warnings introduced
- [x] Re-run discoverability A/B benchmark (`eval-ab.ts`) -- first-choice accuracy within 2%

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Phase A definition
- **Architecture decision:** [docs/research/2026-03-04-phase-0-architecture-gate-decision.md](../research/2026-03-04-phase-0-architecture-gate-decision.md) -- "drop core" with evidence
- **PoC reference (archived):** `packages/tsc-runner/mcp/raw-sdk-poc.ts` -- deleted after migration; patterns now live in `packages/tsc-runner/mcp/index.ts`
- **PoC test (archived):** `packages/tsc-runner/mcp/raw-sdk-poc.test.ts` -- deleted after migration; patterns now live in `packages/tsc-runner/mcp/index.test.ts`
- **Contract artifacts:** [docs/research/2026-03-04-cross-runner-contract-artifacts.md](../research/2026-03-04-cross-runner-contract-artifacts.md) -- title/outputSchema/descriptions for all 7 tools
- **Institutional learning:** [docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md](../solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md) -- re-run A/B benchmark after migration

### External References
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- registerTool, McpServer, InMemoryTransport
- [SDK Issue #654](https://github.com/modelcontextprotocol/typescript-sdk/issues/654) -- structuredContent blocks error reporting
- [SDK Issue #669](https://github.com/modelcontextprotocol/typescript-sdk/issues/669) -- no type safety for structuredContent
- [SDK Issue #699](https://github.com/modelcontextprotocol/typescript-sdk/issues/699) -- thrown errors gobbled with outputSchema
- [SDK SDK #1429](https://github.com/modelcontextprotocol/typescript-sdk/issues/1429) -- Zod v4 incompatibility
- [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal) -- defense-in-depth layering
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) -- MCP-specific threat model
- [MCP Tools Specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) -- structuredContent, outputSchema
