---
status: ready
priority: p2
issue_id: "006"
tags: [mcp, tsc-runner, logging, logtape, observability]
dependencies: ["005"]
---

# Phase D: tsc-runner Observability Uplift

## Problem Statement

`tsc-runner` uses `@side-quest/core` logging which was designed for file-based CLI patterns. MCP servers have different constraints: stdout is sacred (protocol-only), need dual-channel output, and per-request isolation. We need to own the response and logging layers in this repo.

## Findings

- Core logging writes to stdout in some paths -- dangerous for MCP protocol
- No per-request correlation or isolation
- No `fingersCrossed` pattern (silent on success, full trace on failure)
- MCP protocol supports `notifications/message` for sending logs to clients
- LogTape provides: `getStreamSink(stderr)`, `withContext()` + `AsyncLocalStorage`, `fingersCrossed` + `isolateByContext`

## Proposed Solutions

### Option 1: Two-stage rollout

**Approach:**

Stage 1 -- Own response formatting:
- Build response layer in this repo (fork from core if kept, write from scratch if dropped)
- Remove any remaining core response/formatting imports
- Verify identical behavior to current output

Stage 2 -- LogTape dual-channel:
- Replace all remaining logging with inline LogTape
- stderr JSONL sink (`getStreamSink(stderr)`)
- MCP protocol sink bridge (LogTape -> `notifications/message`) with level caps
- `withContext()` + `AsyncLocalStorage` for per-request propagation
- `fingersCrossed` + `isolateByContext` -- silent on success, full trace on failure
- Category hierarchy: `mcp.lifecycle`, `mcp.tools.tsc_check`, `mcp.transport`
- Graceful shutdown with `dispose()` on SIGTERM/SIGINT

**Effort:** 6-8 hours (across both stages)

**Risk:** Medium (Stage 1 is low risk, Stage 2 has concurrency subtleties)

## Recommended Action

To be filled during triage.

## Resources

- [LogTape MCP observability research](/Users/nathanvale/code/side-quest-marketplace/docs/research/2026-03-04-logtape-mcp-server-observability.md)
- [MCP Logging spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/logging)

## Acceptance Criteria

- [ ] Response layer owned locally with behavior parity
- [ ] No core response/formatting imports remain
- [ ] Zero stdout contamination from logging
- [ ] stderr JSONL sink operational
- [ ] MCP protocol sink bridge with level caps
- [ ] Per-request isolation verified under concurrent calls
- [ ] `fingersCrossed` pattern: silent on success, full trace on failure
- [ ] Graceful logger disposal on SIGTERM/SIGINT
- [ ] Logging integration tests pass

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase D
- Depends on Phase C (issue 005)
