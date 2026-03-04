---
title: "Phase 0 Decision: Drop @side-quest/core for MCP integration"
date: 2026-03-04
status: completed
related_plan: docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md
---

# Decision

Drop `@side-quest/core` as the MCP integration layer and migrate runners to raw `@modelcontextprotocol/sdk`.

# Evidence Summary

## PoC implementation (must-complete items 1-5)

Implemented a raw SDK PoC at:

- `packages/tsc-runner/mcp/raw-sdk-poc.ts`

What it proves:

1. `registerTool()` works with:
- `title`
- `outputSchema`
- `annotations`
- `inputSchema` as `z.object(...)`

2. One real tsc subprocess call is executed with inline `spawnWithTimeout()`.

3. Handler returns `CallToolResult` with:
- `content` (text)
- `structuredContent` matching `outputSchema`
- `isError: false` on domain-level type errors.

4. Lifecycle behavior is preserved in raw SDK:
- `stdin.resume()`
- `transport.onclose`
- `SIGINT` and `SIGTERM` handlers

5. Zod compatibility is validated by importing from `zod` directly (not SDK re-export).

## Required runtime validations

Executed:

- `bun test packages/tsc-runner/mcp/raw-sdk-poc.test.ts`
- `bun run --filter @side-quest/tsc-runner typecheck`

Integration test verifies via `InMemoryTransport`:

- `tools/list` includes `title`, `annotations`, `outputSchema`
- `callTool` executes against `packages/tsc-runner/tsconfig.json`
- returned `structuredContent` includes `cwd`, `configPath`, `errors`, `errorCount`

## Dependency/security validation

Executed:

- `bun pm why @modelcontextprotocol/sdk`
- `bun pm why zod`

Result:

- Single SDK resolution: `@modelcontextprotocol/sdk@1.27.1`
- All runners (including transitive through core) now resolve `>= 1.26.0`
- Single zod resolution: `zod@3.25.76`

Implementation detail:

- Verified root override in `package.json` pins SDK workspace-wide:
  - `"overrides": { "@modelcontextprotocol/sdk": "1.27.1" }`

# Rubric outcome

- Glue code required for raw SDK PoC: small and straightforward.
- Security/coupling: direct SDK usage removes cross-repo lag risk for protocol updates.
- Lifecycle behavior is trivially inlined and testable.
- Core remains useful as a temporary utility source during phased migration, but no longer needed for MCP abstraction.

Decision: **Drop core for MCP integration.**

# Migration impact

## Import map changes (Phase A+)

Expected MCP import replacement across runners:

- From `@side-quest/core/mcp` -> `@modelcontextprotocol/sdk/server/mcp.js`
- From `@side-quest/core/mcp-response` wrappers -> direct `CallToolResult` returns
- From `@side-quest/core` utility modules -> local runner utilities / `runner-utils` (non-SDK only)

## Estimated effort

- `tsc-runner`: 4-6 hours (smallest surface area)
- `bun-runner`: 4-6 hours
- `biome-runner`: 4-6 hours

## Rollback strategy

- Per-runner atomic commits.
- Revert runner-specific commit if regression appears.
- Keep workspace green at each step.

# Test mock surface audit

Audit result: no tests currently mock `@side-quest/core` imports.

Current test files:

- `packages/tsc-runner/mcp/index.test.ts`
- `packages/tsc-runner/mcp/raw-sdk-poc.test.ts`
- `packages/bun-runner/mcp/index.test.ts`
- `packages/biome-runner/mcp/index.test.ts`

# Notes

- Existing `packages/tsc-runner/mcp/index.test.ts` writes logs under `~/.claude/logs` and fails in this sandbox due filesystem permissions; this is unrelated to the raw SDK PoC.
