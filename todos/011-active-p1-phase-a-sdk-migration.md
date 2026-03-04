---
status: complete
priority: p1
issue_id: "011"
tags: [mcp, sdk, migration, security, validation, tests]
dependencies: ["001", "002", "002b"]
---

# Phase A: SDK Migration -- Execution Todo

## Tasks

- [x] Migrate tsc-runner to raw MCP SDK (`registerTool`, `CallToolResult`, lifecycle)
- [x] Inline and harden tsc-runner validators + `findNearestTsConfig` git-root boundary
- [x] Add tsc-runner InMemoryTransport integration tests
- [x] Run `bun run validate` after tsc-runner migration
- [x] Migrate biome-runner to raw MCP SDK (`registerTool`, `CallToolResult`, lifecycle)
- [x] Inline and harden biome-runner validators + timeout-capable `spawnAndCollect`
- [x] Add biome-runner InMemoryTransport integration tests
- [x] Run `bun run validate` after biome-runner migration
- [x] Migrate bun-runner to raw MCP SDK (`registerTool`, `CallToolResult`, lifecycle)
- [x] Inline and harden bun-runner validators (`validatePath`, `validateShellSafePattern`)
- [x] Add bun-runner InMemoryTransport integration tests
- [x] Run `bun run validate` after bun-runner migration
- [x] Remove PoC files (`raw-sdk-poc.ts`, `raw-sdk-poc.test.ts`) after replacement coverage
- [x] Verify no `@side-quest/core` references remain in `packages/`
- [x] Re-run discoverability A/B benchmark and confirm <=2% first-choice drop
- [x] Update Phase A plan checkboxes and frontmatter status to `completed`

## Work Log

### 2026-03-04 - Execution Started

**By:** Codex

**Actions:**
- Confirmed branch strategy with user: continue on `docs/deepen-phase-a-plan`
- Read Phase A plan and referenced runner code
- Established runner migration order: tsc -> biome -> bun

### 2026-03-04 - Completed

**By:** Codex

**Actions:**
- Migrated all 3 runners from `@side-quest/core` wrappers to raw MCP SDK `registerTool()` + `CallToolResult` handlers
- Added hardened validators (null byte/control-char checks, git-root realpath boundaries, shell-safe pattern validation)
- Added lifecycle handling (`stdin.resume()`, `transport.onclose`, shutdown guards for SIGINT/SIGTERM) for each runner
- Added InMemoryTransport integration tests for all runners (metadata + `structuredContent`)
- Added traversal/symlink/path-pattern hardening test vectors
- Removed `raw-sdk-poc.ts` and `raw-sdk-poc.test.ts` after replacement coverage was green
- Ran `bun run validate` successfully and re-ran discoverability benchmark
- Benchmark report: `reports/discoverability-ab-2026-03-04T09-21-10.557Z.json` (first-choice delta `0.00`)
