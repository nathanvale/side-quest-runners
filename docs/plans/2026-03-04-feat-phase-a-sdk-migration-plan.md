---
title: "Phase A: SDK Migration -- Drop @side-quest/core for Raw MCP SDK"
type: feat
status: active
date: 2026-03-04
priority: p1
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
decision: docs/research/2026-03-04-phase-0-architecture-gate-decision.md
depends_on: []
absorbs: [003, 014, 015, 016, 020]
---

# Phase A: SDK Migration -- Drop @side-quest/core for Raw MCP SDK

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
| `spawnAndCollect` from `@side-quest/core/spawn` | Inline into biome-runner |
| `findNearestConfig` from `@side-quest/core/fs` | Inline into tsc-runner |
| `validatePathOrDefault, validatePath, validateShellSafePattern` from `@side-quest/core/validation` | Inline into each runner |
| `createPluginLogger, createCorrelationId` from `@side-quest/core/logging` | Remove -- console.error for now, proper logging deferred to Phase D |

### Per-Runner Scope

**tsc-runner** (smallest surface, do first):
- Replace `tool()` + `wrapToolHandler()` with `server.registerTool()` returning `CallToolResult`
- Inline `spawnWithTimeout`, `findNearestConfig`, `resolveWorkdir`, `validatePathOrDefault`
- Promote PoC to production (replace `index.ts` with evolved `raw-sdk-poc.ts`)
- Add lifecycle: `stdin.resume()`, `transport.onclose`, SIGINT/SIGTERM handlers
- Update `package.json`: add `@modelcontextprotocol/sdk` + `zod`, remove `@side-quest/core`

**bun-runner** (medium surface):
- Replace `tool()` + `wrapToolHandler()` with `server.registerTool()`
- Inline `spawnWithTimeout`, `validatePath`, `validateShellSafePattern`
- Handlers return `CallToolResult` directly (throw removal already done in 002b)
- Update `package.json`

**biome-runner** (medium surface):
- Replace `tool()` + `wrapToolHandler()` with `server.registerTool()`
- Inline `spawnAndCollect`, `validatePathOrDefault`
- Handlers return `CallToolResult` directly
- Update `package.json`

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

- **Rollback**: Per-runner atomic commits. Revert runner-specific commit if regression.
- **SDK version**: Root `overrides` already pins `@modelcontextprotocol/sdk` to `1.27.1` workspace-wide.
- **SDK known issues**: outputSchema crashes with `z.optional()` (SDK #1308), enforces `type: "object"` (SDK #1149). Use `.optional()` sparingly and test schema validation.
- **Validation hardening**: Empty string and null byte vectors (from todo 014) must be addressed during validator porting.

## Acceptance Criteria

### Core Migration
- [ ] MCP SDK at `^1.27.1` as direct dependency in all 3 runners
- [ ] `@side-quest/core` removed from all 3 `package.json` files
- [ ] All core imports replaced with raw SDK equivalents or inlined utilities
- [ ] `registerTool()` used with `title`, `outputSchema`, `annotations` for all 7 tools
- [ ] Handlers return `CallToolResult` with `content` + `structuredContent`
- [ ] Lifecycle handling: `stdin.resume()`, `transport.onclose`, signal handlers

### Smoke Tests (per runner)
- [ ] tsc-runner: InMemoryTransport test -- `tools/list` includes title/annotations/outputSchema, `callTool` returns structuredContent
- [ ] bun-runner: InMemoryTransport test -- same verification
- [ ] biome-runner: InMemoryTransport test -- same verification
- [ ] All existing parser tests still pass (no import changes needed)

### Validation Hardening (from todo 014)
- [ ] Empty string path input handled (default or explicit rejection)
- [ ] Null byte path input rejected
- [ ] JSDoc on all validators
- [ ] Test vectors for edge cases

### Performance (from todo 016)
- [ ] `getGitRoot()` called at most once per invocation (cached)
- [ ] Cache reset mechanism for test isolation

### Quality Gates
- [ ] `bun run validate` passes
- [ ] No `@side-quest/core` references remain in `packages/`
- [ ] 20 tests pass (or more, with new integration tests)

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Phase A definition
- **Architecture decision:** [docs/research/2026-03-04-phase-0-architecture-gate-decision.md](../research/2026-03-04-phase-0-architecture-gate-decision.md) -- "drop core" with evidence
- **PoC reference:** `packages/tsc-runner/mcp/raw-sdk-poc.ts` -- working raw SDK implementation
- **PoC test:** `packages/tsc-runner/mcp/raw-sdk-poc.test.ts` -- InMemoryTransport pattern
- **Contract artifacts:** [docs/research/2026-03-04-cross-runner-contract-artifacts.md](../research/2026-03-04-cross-runner-contract-artifacts.md) -- title/outputSchema/descriptions for all 7 tools
