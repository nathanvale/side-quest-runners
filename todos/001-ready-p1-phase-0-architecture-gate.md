---
status: complete
priority: p1
issue_id: "001"
tags: [mcp, sdk, architecture, research]
dependencies: []
---

# Phase 0: Architecture Gate -- raw MCP SDK vs @side-quest/core

## Problem Statement

All three runners depend on `@side-quest/core` which wraps `@modelcontextprotocol/sdk` with a deferred registration pattern. Core was built against SDK v1.20.0. The SDK is now at v1.27.1 and may have caught up on features that originally motivated core. We need to decide whether to keep core or drop it before any implementation work begins.

This decision impacts all downstream interfaces, imports, and test setup. Deferring it creates rework in every subsequent phase.

## Findings

- `@side-quest/core@0.1.1` wraps `@modelcontextprotocol/sdk@^1.20.0` with a deferred queue pattern (`tool()` collects definitions, `startServer()` flushes them)
- Core also provides: `spawnWithTimeout()`, `findNearestConfig()`, `validatePathOrDefault()`, `wrapToolHandler()`, response formatting, logging
- Core uses `"mcpez"` as default server name
- SDK security fix in 1.26.0 (GHSA-345p-7cg4-v4c7)
- SDK 1.27.1 may now support `title`, `outputSchema`, annotations natively

## Proposed Solutions

### Option 1: Keep core slim

**Approach:** Keep `@side-quest/core` for lifecycle (`tool()`, `startServer()`), spawn (`spawnWithTimeout()`), and validation (`findNearestConfig()`, `validatePathOrDefault()`). Remove everything else.

**Pros:**
- Minimal migration effort
- Proven patterns for transport setup
- Shared utilities stay shared

**Cons:**
- Still coupled to core's release cycle
- Core may be abstracting away useful SDK features

**Effort:** Low (bump SDK, verify passthrough)

**Risk:** Low

---

### Option 2: Drop core entirely

**Approach:** Replace `@side-quest/core` with direct `@modelcontextprotocol/sdk@^1.27.1` dependency. Inline the few utilities we need (`spawnWithTimeout`, `findNearestConfig`, validators).

**Pros:**
- Full control over MCP integration
- Direct access to all SDK features
- No wrapper lag when SDK evolves

**Cons:**
- Migration effort across 3 runners
- Must inline or rewrite utility functions
- Lose shared updates from core

**Effort:** Medium (rewrite registration, inline utilities)

**Risk:** Medium

## Recommended Action

To be filled during triage.

## Technical Details

**Key files to audit:**
- `node_modules/.bun/@side-quest+core@0.1.1/` -- core source
- `packages/tsc-runner/mcp/index.ts` -- core usage in tsc-runner
- `packages/bun-runner/mcp/index.ts` -- core usage in bun-runner
- `packages/biome-runner/mcp/index.ts` -- core usage in biome-runner

**Research questions:**
1. Does `McpServer` from SDK now support deferred/declarative tool registration natively?
2. Does the SDK provide built-in error handling that makes `wrapToolHandler` redundant?
3. Does the SDK pass through `title`, `outputSchema`, annotations without needing a proxy?
4. What does core's "mcpez" pattern add vs raw SDK?
5. Are there new SDK features (middleware, lifecycle hooks) that core doesn't expose?

## Resources

- [MCP Tools spec (2025-06-18)](https://modelcontextprotocol.io/docs/concepts/tools)
- [Brainstorm doc](docs/brainstorms/2026-03-04-tsc-runner-uplift.md)
- `@side-quest/core@0.1.1` source audit

## Acceptance Criteria

- [x] Raw `@modelcontextprotocol/sdk@1.27.1` API surface audited
- [x] Feature-for-feature comparison against core documented
- [x] Minimal raw-SDK proof tool built and assessed (time-box: 1 hour)
- [x] Written decision memo: keep slim core vs drop core, with evidence
- [x] Migration impact clearly stated for whichever path is chosen

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase 0

**Learnings:**
- This gates all other phases -- no implementation until decision is made

### 2026-03-04 - Completed

**By:** Codex

**Actions:**
- Added raw SDK PoC at `packages/tsc-runner/mcp/raw-sdk-poc.ts`
- Added InMemoryTransport validation test at `packages/tsc-runner/mcp/raw-sdk-poc.test.ts`
- Documented final decision memo in `docs/research/2026-03-04-phase-0-architecture-gate-decision.md`
- Verified workspace SDK resolution to `@modelcontextprotocol/sdk@1.27.1` via root `overrides`

**Learnings:**
- Raw `registerTool()` covers required metadata and structured output without core wrapper
- Existing dependency override keeps all runners on `>=1.26.0` during migration
