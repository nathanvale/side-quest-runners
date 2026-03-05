---
status: pending
priority: p2
issue_id: "022"
tags: [mcp, architecture, duplication, refactor]
dependencies: []
---

# Extract shared MCP utilities to @side-quest/mcp-core

## Problem Statement

After Phase E cross-runner rollout, bun-runner and biome-runner each contain ~400 LOC of identical utility code copy-pasted from the tsc-runner gold-standard pattern. If a security patch is needed (e.g., path validation fix), it must be applied in 3 places independently. This duplication will compound as runners evolve.

## Findings

From branch review of `feat/phase-e-cross-runner-rollout` (2026-03-05):

**Duplicated functions across all 3 runners (tsc, bun, biome):**

| Function | Purpose | LOC (approx) |
|----------|---------|--------------|
| `getGitRoot()` / `resolveGitRoot()` | Find repo boundary | 25 |
| `validatePath()` | Multi-layer path security (null bytes, control chars, symlinks, repo boundary) | 35 |
| `resolveNearestAncestor()` | Walk up to find existing parent | 20 |
| `hasControlCharacters()` | Security check | 10 |
| `toStructured()` | SDK type cast workaround | 5 |
| `createMcpProtocolSink()` | LogTape -> MCP protocol bridge | 30 |
| `shouldForwardMcpLog()` / `stringifyLogMessage()` | Log filtering/formatting | 15 |
| `setupObservability()` | LogTape dual-channel init with fingerscrossed | 45 |
| `createBunStderrWritableStream()` | Buffered stderr stream | 35 |
| `LOGTAPE_TO_MCP_LEVEL` / `MCP_LOG_LEVEL_SEVERITY` | Log level mappings | 20 |

**Total duplicated:** ~240 LOC x 3 runners = ~720 LOC that should be ~240 LOC shared.

**Security-critical duplication:** `validatePath`, `hasControlCharacters`, `resolveNearestAncestor` -- a CVE fix in one runner could be missed in the others.

## Proposed Solutions

### Option A: New `packages/mcp-core` internal package (Recommended)

**Approach:** Create `@side-quest/mcp-core` as a workspace package exporting shared utilities. Each runner imports from it.

**Exports:**
- `path-security.ts` -- `validatePath`, `resolveNearestAncestor`, `hasControlCharacters`, `getGitRoot`, `resolveGitRoot`
- `observability.ts` -- `setupObservability`, `createMcpProtocolSink`, `shouldForwardMcpLog`, `stringifyLogMessage`, `createBunStderrWritableStream`, log level maps
- `sdk-helpers.ts` -- `toStructured`, common Zod schemas (response_format enum)
- `spawn.ts` -- `spawnWithTimeout` (parameterized timeout/kill delay)

**Pros:** Single source of truth, security patches in one place, reduces each runner by ~200 LOC, testable independently.
**Cons:** New package to maintain, cross-package import overhead (minimal with Bun).
**Effort:** ~2-3 hours.
**Risk:** Low -- purely mechanical extraction, no behavior changes.

### Option B: Shared `src/shared/` directory without new package

**Approach:** Move shared code to `src/shared/` at repo root, import via path aliases.

**Pros:** Simpler setup, no new package.json.
**Cons:** Breaks monorepo package isolation, harder to test independently, path aliases need config.
**Effort:** ~1-2 hours.
**Risk:** Low.

### Option C: Leave as-is, lint for drift

**Approach:** Accept duplication, add a CI check that diffs the shared functions across runners to detect drift.

**Pros:** Zero refactoring, catches divergence.
**Cons:** Doesn't reduce LOC, drift detection is fragile, doesn't prevent bugs.
**Effort:** ~1 hour.
**Risk:** Medium -- drift detection may have false positives/negatives.

## Recommended Action

TBD -- needs triage approval.

## Acceptance Criteria

- [ ] Shared utilities extracted to a single location
- [ ] All 3 runners import from the shared location (no inline copies)
- [ ] `validatePath` and security functions have a single source of truth
- [ ] Existing tests pass without modification (or minimal adaptation)
- [ ] No behavior changes -- pure mechanical extraction
- [ ] New shared code has its own unit tests

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts`
- `packages/bun-runner/mcp/index.ts`
- `packages/biome-runner/mcp/index.ts`

**Related:**
- todo 001 (architecture gate) decided to drop `@side-quest/core` -- this is the natural successor for shared code
- Phase E established the gold-standard pattern that created the duplication

## Work Log

### 2026-03-05 - Created from branch review

**By:** Claude Code

**Actions:**
- Identified during review of `feat/phase-e-cross-runner-rollout` branch
- Catalogued all duplicated functions with LOC estimates
- Proposed 3 solution options

**Learnings:**
- The duplication was intentional during Phase E to avoid blocking rollout
- Security-critical functions (path validation) being duplicated is the primary risk
- Option A aligns with the original Phase 0 architecture gate direction
