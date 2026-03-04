---
title: "Phase 0: Architecture Gate -- raw MCP SDK vs @side-quest/core"
type: feat
status: completed
date: 2026-03-04
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
deepened: 2026-03-04
reviewed: 2026-03-04
---

# Phase 0: Architecture Gate -- raw MCP SDK vs @side-quest/core

## Overview

Decide whether to keep `@side-quest/core` as a slim wrapper or drop it entirely in favor of raw `@modelcontextprotocol/sdk@^1.27.1`. This decision gates all downstream phases (A through E) of the tsc-runner uplift. (See brainstorm: `docs/brainstorms/2026-03-04-tsc-runner-uplift.md`)

## Problem Statement

All three MCP runners (`tsc-runner`, `bun-runner`, `biome-runner`) depend on `@side-quest/core@0.1.1`, which wraps `@modelcontextprotocol/sdk@^1.20.0` (resolved to 1.25.3). The SDK is now at 1.27.1 with:

- **Security fix** in 1.26.0 (CVE-2026-25536 -- cross-client data leak from transport reuse)
- **`registerTool()` API** supporting `title`, `outputSchema`, `annotations`
- **Built-in error handling** (try/catch in tool handlers, returns `isError: true`)
- **Dynamic tool registration** (tools can be added before or after `connect()`)

Core uses only 6 of 24 available subpaths. The 18 unused subpaths (geo, oauth, password, html, vtt, etc.) are dead weight from the broader side-quest-marketplace product.

### Research Insights

**Community context:** The MCP ecosystem now has 1,864+ servers. Tool description quality is the #1 factor in agent routing. ESLint MCP ships the protocol natively in the CLI (no wrapper). Cloudflare's MCP uses just 2 tools and reduced input tokens by 99.9% -- minimal surface area wins.

**SDK deprecation:** The SDK's `tool()`, `prompt()`, `resource()` convenience methods are deprecated since v1.25. `registerTool()` is the blessed replacement. Note: core's own `tool()` function is a separate wrapper that already calls `registerTool()` internally -- it is not the same as the deprecated SDK method.

**SDK v1.25 breaking change:** v1.25.0 removed loose/passthrough types not defined by MCP spec. Strict schema compliance is now required. Also: TypeScript target moved to ES2020 -- verify `tsconfig.json` compatibility.

**Context pollution:** Claude Code lazy-loads MCP tools via `defer_loading`. Fewer tools with better descriptions = better routing accuracy.

---

## Proposed Solution

### Expected outcome: Drop core

The evidence overwhelmingly favors dropping `@side-quest/core`. The PoC exists to **confirm this with evidence**, not to make a genuinely balanced evaluation.

**Correction (staff review, 2026-03-04):** Core's `ToolOptions` type *does* support `title`, `outputSchema`, and full `annotations` -- its `tool()` function passes these through to `registerTool()` without filtering. The runners simply never used them. The original claim that "core blocks access" was incorrect.

The actual reasons to drop core are strong enough on their own:

- **CVE exposure** -- Core pins to `^1.20.0` (resolved 1.25.3), below the 1.26.0 security fix (CVE-2026-25536). Bumping requires a release in the separate `side-quest-core` repo, then version bumps in all three runners -- cross-repo coordination friction for a security patch.
- **Cross-repo release friction** -- Any core change requires: PR to core repo, release, version bump in runners. This is disproportionate overhead for ~140 lines of glue code.
- **Dead weight** -- 18 of 24 subpaths are unused (geo, oauth, password, html, vtt, etc.) from the broader side-quest-marketplace product. Core's validation chunk alone loads 28KB of dead code (entire fs/git modules) for 2 functions.
- **Glue code is small** -- Core provides ~140 lines of non-trivial glue -- well under the 200-line "keep" threshold.

**The PoC validates. It does not discover.** If the PoC reveals > 200 lines of non-trivial glue or an unexpected blocker, that reverses the default. Otherwise: drop core.

### PoC scope (time-boxed 1 hour)

Build a minimal `tsc_check` tool using raw SDK to confirm:

**Must complete (items 1-5):**

1. **Registration** -- `registerTool()` with `title`, `outputSchema`, `annotations`. Note: `registerTool()` requires `z.object()` wrapper around input schema (not raw Zod shapes like current `tool()` calls).
2. **Spawn** -- One tsc subprocess call via inlined `spawnWithTimeout()`
3. **Response** -- Return `CallToolResult` with both `content` (text) and `structuredContent` (matching `outputSchema`). Verify `isError: false` for type errors found (domain result).
4. **Lifecycle** -- `stdin.resume()`, `transport.onclose`, signal handlers
5. **Zod compatibility** -- Register tool with Zod schema from separately-installed `zod@^3.25` package (not re-exported from SDK). Verify no `instanceof` failures. Also verify `bun pm ls zod` shows single resolution.

**Stretch (item 6) -- defer to Phase A if time-boxed out:**

6. **Agent metadata verification** -- Use `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js` to call `tools/list` and assert `title`, `outputSchema`, and `annotations` are present in the response.

**PoC validation (required):** Execute the PoC against `packages/tsc-runner/tsconfig.json` and confirm it produces structured output matching the current tsc-runner's JSON format. Compilation alone is not sufficient -- the PoC must run and produce correct results.

**If PoC incomplete at 1 hour:** Document what completed, what blocked, estimate remaining effort. An incomplete PoC is valid data. Stretch items not completing does NOT count as evidence to "keep core."

**PoC as seed:** Write the PoC at production quality. Phase A starts by extending it rather than rewriting from scratch. This justifies spending slightly more time on structure.

### Decision rubric (confirmation, not balance)

| Signal | Keep core | Drop core | Current evidence |
|--------|-----------|-----------|------------------|
| Glue code for raw SDK PoC | > 200 lines of non-trivial logic | < 50 lines of glue code | ~140 lines in core, most trivially inlined |
| SDK version coupling | Core bumps to `^1.27.1` without friction | Core pins to outdated SDK with CVE | **Core pins to ^1.20.0, separate repo, CVE below resolved version** |
| Cross-repo coordination | Low friction (infrequent changes) | High friction (separate repo, release, bump) | **Every core change requires cross-repo PR + release + bump** |
| Lifecycle management | Core's auto-start, stdin.resume, singleton add real value | < 20 lines, trivially inlined | **~40 lines total** |
| Dead weight | Core trims unused subpaths | Core ships 18 unused subpaths | **18 of 24 subpaths unused** |

**"Non-trivial" definition:** Lines of logic excluding imports, type definitions, blank lines, and comments. Count lines that would break behavior if removed.

**Borderline result (50-200 lines):** Drop core regardless. The CVE exposure, cross-repo friction, and dead weight arguments hold independent of line count. The threshold exists to catch "core does more than we thought," not to justify keeping core at 140 lines. Extract shared utilities to `packages/runner-utils` from day one.

---

## Technical Considerations

### What core actually provides to runners

| Module | What's used | Lines | Inline difficulty | Notes |
|--------|-------------|-------|-------------------|-------|
| `/mcp` | `tool()`, `startServer()`, `z` re-export | ~300 | Medium | Deferred queue, auto-start, singleton, stdin.resume, transport.onclose |
| `/mcp-response` | `wrapToolHandler()`, `ResponseFormat`, `createLoggerAdapter` | ~130 | Easy | Pure functions, self-contained |
| `/spawn` | `spawnWithTimeout()`, `spawnAndCollect()` | ~120 | Very easy | Wraps Bun APIs directly |
| `/validation` | `validatePath()`, `validatePathOrDefault()`, `validateShellSafePattern()` | ~200 | Medium | **Security-critical** -- git-based path traversal guards |
| `/fs` | `findNearestConfig()`, `NearestConfigResult` type | ~30 used | Easy | Only tsc-runner uses this |
| `/logging` | `createPluginLogger()`, `createCorrelationId()` | ~350 | Medium | **Moves in-repo regardless** (brainstorm decision) |

### Complete import map across runners

| Import | tsc-runner | bun-runner | biome-runner |
|--------|------------|------------|--------------|
| `tool`, `startServer`, `z` from `/mcp` | Y | Y | Y |
| `wrapToolHandler`, `ResponseFormat` from `/mcp-response` | Y | Y | Y |
| `createLoggerAdapter`, `Logger` from `/mcp-response` | - | Y | Y |
| `createCorrelationId`, `createPluginLogger` from `/logging` | Y | Y | Y |
| `spawnWithTimeout` from `/spawn` | Y | Y | - |
| `spawnAndCollect` from `/spawn` | - | - | Y |
| `validatePathOrDefault` from `/validation` | Y | - | Y |
| `validatePath`, `validateShellSafePattern` from `/validation` | - | Y | - |
| `findNearestConfig`, `NearestConfigResult` from `/fs` | Y | - | - |

### SDK 1.27.1 vs core feature comparison

| Capability | Core (`tool()`) | SDK (`registerTool()`) |
|------------|-----------------|----------------------|
| Tool registration | Deferred queue -- register before server exists | Dynamic -- before or after `connect()` |
| `title` field | Supported (passthrough) -- runners never used it | Supported |
| `outputSchema` field | Supported (passthrough) -- runners never used it | Supported -- returns `structuredContent` |
| `annotations` | Supported (passthrough) | Full support |
| Error handling | `wrapToolHandler()` try/catch | Built-in try/catch, returns `isError: true` |
| Zod schemas | Re-exports `z` from core | Peer dep (`^3.25 \|\| ^4.0`) -- import directly |
| Tool lifecycle | No per-tool control | `enable()`, `disable()`, `remove()`, `update()` per tool |
| Input schema format | Raw Zod shapes (`{ name: z.string() }`) | Requires `z.object()` wrapper |
| Handler signature | `(args, format) => string` | `(args, ctx) => CallToolResult` |

### SDK migration mechanics (from research)

Key API differences that affect every handler:

1. **Input schema:** `registerTool()` requires `z.object()` wrapper, not raw shapes. Current `inputSchema: { path: z.string() }` becomes `inputSchema: z.object({ path: z.string() })`.

2. **Handler return type:** Handlers must return `CallToolResult`, not plain strings:
   ```typescript
   return {
     content: [{ type: 'text' as const, text: formatResult(result) }],
     structuredContent: result,  // when outputSchema is defined
     isError: false,
   }
   ```

3. **Handler context:** SDK passes `ctx` as second parameter (provides `ctx.mcpReq.log()` for in-protocol logging). Current handlers ignore this parameter, which is fine -- TypeScript allows unused callback parameters.

4. **`structuredContent` validation:** When `outputSchema` is defined and `structuredContent` doesn't match, the SDK throws a hard error (not graceful `isError`). Schemas must match actual output exactly. Note: no compile-time type safety for `structuredContent` (GitHub Issue #669) -- runtime validation only.

5. **Import paths:**
   ```typescript
   import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
   import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
   import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
   import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
   ```
   Verify `.js` extension resolution works in Bun during PoC (SDK uses wildcard `exports` map).

### `wrapToolHandler` replacement strategy

**Recommendation: Drop `wrapToolHandler`.** Use the SDK's built-in error handling and a thin `withLogging` wrapper that preserves full type inference from Zod schemas. The wrapper's generic constraint should use `ZodRawShape` (from zod) -- not `ZodRawShapeCompat` which does not exist in the SDK or zod. This preserves Zod-inferred arg types through the handler (unlike current `wrapToolHandler` which erases them to `Record<string, unknown>` in bun-runner). The `ResponseFormat` enum becomes unnecessary -- drop it, use string literal `'json' | 'markdown'` directly. See todo `011-pending-p2-zodrawshapecompat-incorrect-type.md` for implementation details.

### Core lifecycle behaviors that must be preserved

If dropping core, each runner replicates ~15-20 lines of server bootstrap: `McpServer` construction, `StdioServerTransport`, `connect()`, `stdin.resume()`, `transport.onclose`, and SIGINT/SIGTERM handlers. This is healthy duplication -- avoids re-creating another MCP abstraction layer.

**Bun-specific note:** `stdin.resume()` is required -- without it, Bun exits immediately after `server.connect()` completes. The `transport.onclose` handler calling `process.exit(0)` ensures the process doesn't hang after the client disconnects. Bun's `'exit'` event handler cannot do async work -- keep shutdown synchronous.

### Where shared code lives: `packages/runner-utils`

**Boundary rule:** `runner-utils` MUST NOT re-export or wrap MCP SDK types. It provides non-SDK infrastructure only. Runners import SDK types directly. This prevents runner-utils from becoming another abstraction layer like core -- features are outcomes achieved by composing primitives, not shared wrappers.

**Enforcement:** Add a `no-restricted-imports` Biome rule (or equivalent) in `packages/runner-utils` that prohibits importing from `@modelcontextprotocol/sdk`. This is a Phase A deliverable, enforced in CI from day one. Without mechanical enforcement, runner-utils will drift toward becoming core v2.

**Package config:** `"private": true` -- never published to npm. Workspace-internal only. Point exports at `.ts` source files directly -- Bun resolves TypeScript natively, no build step needed for internal consumption.

**Scope (detailed module design deferred to Phase A):** spawn utilities, path validation, response formatting, env allowlist, logging. `findNearestConfig()` co-locates in tsc-runner only (single consumer). Each runner owns its own server bootstrap (not shared).

**Shared constants to extract (7x duplication each):** `responseFormatSchema`, `READ_ONLY_ANNOTATIONS`, `DESTRUCTIVE_ANNOTATIONS` -- see Phase A todos for details.

### Agent-native design (Phase A deliverables)

The migration is the lowest-cost moment to get agent-native design right. Phase A deliverables:

1. **Add `title` to all 7 tools** -- display labels for human-readable UI (not routing signals -- agents route by tool name). See `tsc_check: "TypeScript Type Checker"`, etc.
2. **Add `outputSchema` to all 7 tools** -- including `bun_testCoverage` and `biome_lintFix` (currently missing from scope). Normalize snake_case fields (`error_count`, `unformatted_files`) to camelCase before adding schemas (see todo 013).
3. **Fix `openWorldHint: false` -> `true`** on all 7 tools -- they interact with the local filesystem.
4. **Enrich tool descriptions** with routing keywords ("when to use this tool", "output shape").

### Security considerations

**Path validation (`validatePath`, `validatePathOrDefault`):**
- Uses `path.resolve()` to canonicalize, then `fs.realpath()` to resolve symlinks before comparison against git root
- **Pre-existing vulnerability:** `isFileInRepo()` catch fallback skips symlink resolution. If `realpath()` fails, falls back to naive `startsWith` check -- a symlink at `./link` pointing to `/etc/` would pass. **Fix during port: reject paths when `realpath` fails instead of falling back.**
- **ELOOP exploitation vector:** Attacker creates circular symlink chain that forces `realpath()` to fail with `ELOOP`, reliably triggering the unsafe fallback. More reliable than hoping `realpath` fails for other reasons.
- Port with full test suite. Required test vectors: symlink traversal, `../` path traversal, absolute path outside repo, empty/whitespace input, shell metacharacter injection, **null byte injection** (`\x00`), **ELOOP symlink chains**, **Unicode normalization**, **very long paths** (DoS)
- Line-by-line diff review of ported validation against core source
- `validatePathOrDefault` skips validation when `path === defaultPath` -- document this assumption or remove the `defaultPath` parameter

**Shell pattern validation (`validateShellSafePattern`):**
- Rejects `; & | < > \` $ \\` via regex
- Does NOT reject `\n`, `\r`, or other control characters -- safe only because arguments are passed as array elements to `Bun.spawn()`, not shell-interpolated
- **FLAG INJECTION (P1):** Does NOT reject patterns starting with `-` or `--`. A pattern like `--preload=./malicious.ts` passes validation and gets injected as a bun flag via `['bun', 'test', pattern]`. Array-based spawn prevents shell metachar injection but not flag injection. Fix: (1) reject patterns starting with `-`, AND (2) use `--` separator in spawn args: `['bun', 'test', '--', pattern]`. See todo `009-pending-p1-bun-test-flag-injection.md`.
- **Harden during port:** Extend regex to reject all ASCII control characters as defense-in-depth: `/[;&|<>\`$\\\x00-\x1f\x7f]/`
- **JSDoc must document** this safety depends on array-based spawn

**Environment variable forwarding (P1 -- hotfix before Phase A):**
- tsc-runner currently passes `{ ...process.env, CI: 'true' }` -- leaks entire environment to child processes
- `spawnAndCollect` in core always merges `...process.env` even when caller provides partial env -- bun-runner passes `{ CI: 'true' }` thinking it's minimal, but core spreads full env underneath
- **This leak is active now**, not a theoretical future risk. Any env var (API keys, tokens, secrets) set by Claude Code, IDE extensions, or shell profiles is forwarded to every subprocess.
- **Fix: ship `safeEnv()` as a standalone hotfix PR before Phase A begins.** The fix is small (one function + 3 call site updates) and does not depend on the SDK migration. See todo `010-pending-p1-safeenv-hotfix-timing.md`.

**`shellExec` exclusion:** Core's spawn module exports `shellExec()` which accepts raw command strings for shell interpolation. **runner-utils MUST NOT include `shellExec` or any shell-string-based execution.** Only array-based spawn is safe.

### Logging migration (must be scoped)

Core's logging module is ~350 lines (LogTape, file rotation, correlation IDs). When core is dropped, LogTape becomes a direct dependency. Destination (`runner-utils/logging.ts` or `packages/logging`) decided in Phase A. Decision: all runners standardize on `createLoggerAdapter` pattern.

### Performance notes

Architecture decision is performance-neutral for per-invocation latency (subprocesses dominate by 99%+). Two Phase A optimizations enabled: (1) cache `getGitRoot()` per process lifetime -- currently called up to 4 times per tsc-runner invocation (see todo 016), saves 10-100ms; (2) switch `JSON.stringify(obj, null, 2)` to compact -- ~60-70% token overhead reduction (see todo 018 for corrected figure).

---

## System-Wide Impact

- **All 3 runners affected** -- import paths change regardless of decision
- **Migration order:** tsc-runner first (smallest surface area, 1 tool, fewest core imports, no `createLoggerAdapter`), then bun-runner, then biome-runner. Validate each before proceeding to the next.
- **Commit strategy:** Each runner migration is a self-contained commit (or PR). Rollback is per-runner, not per-branch. The feature branch should be structured so that any prefix of runner migrations produces a green CI.
- **Intermediate state:** During migration, the monorepo depends on both core and raw SDK. Core's `^1.20.0` range includes 1.27.1, so Bun should hoist to a single copy. **Verify after first migration:** `bun pm ls @modelcontextprotocol/sdk` must show a single version >= 1.27.1. If two versions exist, add `resolutions` to root `package.json`.
- **Test setup changes** -- tests that mock core imports need updating. Current test surface is light (tsc-runner only tests `parseTscOutput` pure function), but bun-runner and biome-runner may mock spawn/validate imports. **Audit before Phase A.**
- **CI unchanged** -- same build/test commands
- **No user-facing changes** -- tool behavior identical (except improved `isError` semantics for bun-runner test failures)
- **Testing strategy post-migration:** Unit tests for handlers + `InMemoryTransport` integration tests. Extract server factory (`createRunnerServer()`) for testability -- entry point calls factory, tests use `InMemoryTransport.createLinkedPair()`. Note: zero handler-level test coverage exists today across all 3 runners (see todo 015).
- **Smoke test definition:** (1) `bun test` passes for the runner, (2) runner starts via `bun run packages/X-runner/mcp/index.ts` without crashing, (3) `tools/list` returns expected tool names.

---

## Acceptance Criteria

- [x] PoC built: `tsc_check` on raw SDK with `registerTool()`, including `title`, `outputSchema`, `annotations` (must-complete items 1-5)
- [x] PoC validated: executes against real `packages/tsc-runner/tsconfig.json` and produces correct structured output
- [x] PoC validates: Zod from separate `zod@^3.25` works with `registerTool()`. `bun pm ls zod` shows single resolution.
- [x] PoC validates (stretch): `title` and `outputSchema` visible via `tools/list` using `InMemoryTransport`
- [x] Decision documented: keep or drop, with evidence against rubric
- [x] If dropping: `runner-utils` scope, logging destination, migration order, `wrapToolHandler` replacement confirmed
- [x] Migration impact: import map changes, effort estimate, rollback plan (per-runner commits)
- [x] Dual-dependency: `bun pm ls @modelcontextprotocol/sdk` shows single version >= 1.26.0
- [x] Security: all runners resolve SDK >= 1.26.0. If keeping core, version bump is a Phase 0 deliverable.
- [x] Test mock surface audit: catalog all test files that mock core imports

Phase A and fix-while-migrating items are tracked in todos 003-007 and 008-022. Not repeated here.

---

## Dependencies & Risks

### Dependencies

- None -- this is the first phase, it gates everything else
- Phase 0b (contract artifacts) can run in parallel

### Risks

| Risk | Mitigation |
|------|------------|
| PoC exceeds 1-hour time-box | Scope defined upfront. Incomplete PoC is valid data. PoC is a seed for Phase A (not throwaway), so extra time invested pays forward. |
| Validation inlining introduces security gaps | Line-by-line diff review against core source. Expanded test vectors: symlink traversal, `../`, absolute path, empty/whitespace, shell metacharacters, null bytes, ELOOP symlinks, Unicode normalization, long paths. |
| Migration leaves repo in inconsistent state | Feature branch with per-runner commits. Any prefix of migrations produces green CI. Git revert as rollback per runner. |
| Dual SDK versions during intermediate migration | Verify with `bun pm ls @modelcontextprotocol/sdk`. Force single resolution via `resolutions` field if needed. |
| bun-runner error semantics silently change | Elevated to Phase A blocker. SDK catches thrown errors and loses structured `TestSummary` -- must fix before/during bun-runner migration. |
| Zod instance incompatibility | PoC must-complete item 5 tests this directly. Pin `"zod": "^3.25"` as explicit dep in each runner. |
| `runner-utils` becomes the new core | Boundary rule enforced by import restriction lint rule in CI. Agent-native framing: primitives not abstractions. |
| SDK releases breaking change mid-migration | Use `^1.27.1` but lock `bun.lock` after first successful migration. Do not update SDK mid-migration. |
| `structuredContent` runtime validation throws on mismatch | No compile-time safety (GitHub Issue #669). Add integration tests via InMemoryTransport to catch schema/output mismatches. |

---

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Key decisions: (1) core dependency is a gate; (2) logging moves in-repo regardless; (3) tsc-runner is proving ground

### Internal References

- `packages/tsc-runner/mcp/index.ts` -- tsc-runner source (270 lines)
- `packages/bun-runner/mcp/index.ts` -- bun-runner source (422 lines)
- `packages/biome-runner/mcp/index.ts` -- biome-runner source (495 lines)
- `node_modules/.bun/@side-quest+core@0.1.1+*/` -- core source (built artifacts)

### External References

- [MCP Tools spec (2025-06-18)](https://modelcontextprotocol.io/docs/concepts/tools) -- `title`, `outputSchema`
- [CVE-2026-25536 (GHSA-345p-7cg4-v4c7)](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-345p-7cg4-v4c7) -- security fix in SDK 1.26.0
- [@modelcontextprotocol/sdk changelog](https://github.com/modelcontextprotocol/typescript-sdk/releases) -- v1.20 through v1.27.1
- [registerTool migration (Issue #1284)](https://github.com/modelcontextprotocol/typescript-sdk/issues/1284) -- `tool()` deprecated, `registerTool()` blessed
- [MCPcat testing guide](https://mcpcat.io/guides/writing-unit-tests-mcp-servers/) -- InMemoryTransport testing pattern
- [MCP Security Best Practices (Official)](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)
- [Snyk - Path Traversal in MCP Servers](https://snyk.io/articles/preventing-path-traversal-vulnerabilities-in-mcp-server-function-handlers/)
- [MCP context pollution / defer_loading](https://www.atcyrus.com/stories/mcp-tool-search-claude-code-context-pollution-guide)
- [ESLint MCP (linter-native, no wrapper)](https://eslint.org/docs/latest/use/mcp)
- [SDK structuredContent type safety (Issue #669)](https://github.com/modelcontextprotocol/typescript-sdk/issues/669)
- [SDK structuredContent validation behavior (Issue #654)](https://github.com/modelcontextprotocol/typescript-sdk/issues/654)
- [MCP Lifecycle Specification](https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle)

### Related Work

- Todo: `001-ready-p1-phase-0-architecture-gate.md`
- Parallel: `002-ready-p1-phase-0b-contract-artifacts.md` (no dependency)
- Blocked by this: `003-ready-p1-phase-a-foundation.md` through `007-ready-p2-phase-e-cross-runner-rollout.md`
- Code review findings: `008-pending-p1` through `022-pending-p3` (from 2026-03-04 review)
