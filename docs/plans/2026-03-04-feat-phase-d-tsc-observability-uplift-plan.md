---
title: "Phase D: tsc-runner Observability Uplift"
type: feat
status: active
date: 2026-03-04
priority: p2
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
depends_on: [phase-c]
absorbs: [006]
---

# Phase D: tsc-runner Observability Uplift

## Overview

Own response formatting and logging layers locally. Replace `@side-quest/core` logging with LogTape dual-channel pipeline (stderr JSONL + MCP protocol sink). This is P2 -- the runner works without it, but operational visibility is poor.

## Problem Statement

After Phase A removes `@side-quest/core`, runners have no structured logging. MCP servers have specific constraints that differ from CLI logging:

- **stdout is sacred** -- only MCP protocol messages allowed on stdout
- **Dual-channel needed** -- structured logs to stderr (for operators) + MCP notifications (for clients)
- **Per-request isolation** -- concurrent tool calls need correlation IDs
- **Failure context** -- silent success on happy path, full trace dump on failure

## Proposed Solution

### Stage 1: Own Response Formatting

- Build minimal response layer in this repo
- Format tool output (JSON vs markdown) without core dependency
- Verify identical behavior to current output

### Stage 2: LogTape Dual-Channel

- **stderr JSONL sink** -- `getStreamSink(stderr)` for operator visibility
- **MCP protocol sink bridge** -- LogTape -> `notifications/message` with level caps
- **Per-request propagation** -- `withContext()` + `AsyncLocalStorage` for correlation IDs
- **fingersCrossed pattern** -- silent on success, full trace dump on failure via `fingersCrossed` + `isolateByContext`
- **Category hierarchy** -- `mcp.lifecycle`, `mcp.tools.tsc_check`, `mcp.transport`
- **Graceful shutdown** -- `dispose()` on SIGTERM/SIGINT

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

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Phase D definition
- **Research:** [LogTape MCP observability](https://github.com/user/side-quest-marketplace/docs/research/2026-03-04-logtape-mcp-server-observability.md)
- **Spec:** [MCP Logging (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/logging)
