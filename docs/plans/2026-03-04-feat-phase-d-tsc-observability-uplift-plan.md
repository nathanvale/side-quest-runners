---
title: "Phase D: tsc-runner Observability Uplift"
type: feat
status: completed
date: 2026-03-04
priority: p2
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
depends_on: [phase-c]
absorbs: [006]
deepened: 2026-03-05
deepened_rounds: 2
---

# Phase D: tsc-runner Observability Uplift

## Enhancement Summary

**Deepened on:** 2026-03-05 (2 rounds)
**Sources:**
- Best-practices research: LogTape, MCP logging spec, fingersCrossed pattern, AsyncLocalStorage
- Community intelligence: Reddit (r/mcp, r/typescript), X (@zeeg, @mattpocockuk, @hongminhee), web research

### Key Improvements

1. Bun-specific `WritableStream` adapter documented (LogTape + Bun gotcha)
2. Level mapping table (LogTape 6 levels -> MCP 8 RFC 5424 levels)
3. fingersCrossed memory management parameters specified
4. MCP protocol sink implementation pattern with connection guard
5. Concrete testing strategies for all logging behaviors
6. Shutdown ordering constraint: `dispose()` before `server.close()`
7. **LogTape validated as best-in-class for Bun** -- 4x faster than Pino on Bun, confirmed MCP server usage by Sentry's @zeeg
8. **`notifications/message` client adoption gap** identified (Inspector #610) -- stderr JSONL is the reliable channel
9. **fingersCrossed is novel in MCP space** -- no public implementations exist; we'd set the pattern
10. **`jsonLinesFormatter` API name needs verification** against LogTape v2.x JSR reference

### New Considerations Discovered

- `contextLocalStorage: new AsyncLocalStorage()` must be passed to `configure()` or `withContext()` silently no-ops
- MCP server must declare `{ capabilities: { logging: {} } }` or clients reject notifications
- `sendLoggingMessage` throws if called before `connect()` -- sink needs a `connected` guard
- Never use `enterWith()` in long-lived servers -- leaks context globally
- MCP protocol sink should default to `warning`+ to avoid flooding the client/LLM
- **Servers produce zero log output via `notifications/message` until client sends `setLevel`** -- most clients never send it (Inspector #610)
- **fingersCrossed buffer flush errors are silently ignored** by LogTape -- add explicit error handling
- **LogTape GC-reset bug** (now fixed) previously caused configured sinks to silently reset after inactivity -- pin to v2.0.4+

## Overview

Own response formatting and logging layers locally. Replace `@side-quest/core` logging with LogTape dual-channel pipeline (stderr JSONL + MCP protocol sink). This is P2 -- the runner works without it, but operational visibility is poor.

## Problem Statement

After Phase A removes `@side-quest/core`, runners have no structured logging. MCP servers have specific constraints that differ from CLI logging:

- **stdout is sacred** -- only MCP protocol messages allowed on stdout
- **Dual-channel needed** -- structured logs to stderr (for operators) + MCP notifications (for clients)
- **Per-request isolation** -- concurrent tool calls need correlation IDs
- **Failure context** -- silent success on happy path, full trace dump on failure

### Community Validation

The stdio logging trap is the most-shared MCP pain point. @mattpocockuk (432 likes): *"You can't console.log in local MCP servers. Your MCP server connects via the same channel console.log uses (stdio). So the logs get swallowed."* Every new MCP builder hits this.

No built-in request ID propagation exists in the MCP spec -- correlation across tool calls requires manual plumbing. Our `withContext()` + `AsyncLocalStorage` approach fills a real gap that the community has identified but not solved.

## Technology Decision: LogTape

### Why LogTape over alternatives

| Metric | LogTape | Pino | Winston |
|--------|---------|------|---------|
| Bun perf (ns/iter) | **225** | 874 | 2,397 |
| Bundle size | 5.3KB | 3.1KB | 38.3KB |
| Dependencies | **0** | 1 | 17 |
| Bun support | **Native** | Partial | Partial |
| Deno/Edge/Browser | **Full** | Partial | No |
| fingersCrossed | **Built-in** | No | No |
| AsyncLocalStorage context | **Built-in** | Manual | Manual |

**Real-world MCP validation:** @zeeg (David Cramer, Sentry founder) went from skepticism about LogTape's name (Sep 2025) to *"coerced the Sentry team into supporting it and migrated my MCP service to it"* (Feb 2026). Sentry published a dedicated integration guide (Jan 2026).

**Ecosystem trajectory:** v2.0.0 shipped Jan 2026 with framework integrations (`@logtape/elysia`, `@logtape/hono`, `@logtape/express`, `@logtape/drizzle-orm`). Graduating from niche to mainstream. v2.0.4 (Feb 2026) fixes a Bun-specific regex bug -- shows active Bun testing.

**Pin to:** `@logtape/logtape@^2.0.4` (fixes GC-reset bug + Bun regex bug)

### Known LogTape issues

- **`jsonLinesFormatter` name** -- may appear as `getJsonLinesFormatter()` in current docs. Verify against JSR API reference before implementation
- **fingersCrossed flush errors** are silently ignored -- wrap critical flush paths with explicit error handling
- **Multi-version import bug** (fixed) -- previously, two LogTape versions in the same runtime meant Logger instances weren't shared
- **GC-reset bug** (fixed in v2.0.4) -- configured sinks were previously reset after inactivity due to GC of Logger instances

## Proposed Solution

### Stage 1: Own Response Formatting

- Build minimal response layer in this repo
- Format tool output (JSON vs markdown) without core dependency
- Verify identical behavior to current output

### Stage 2: LogTape Dual-Channel

- **stderr JSONL sink** -- `getStreamSink(stderr)` with `jsonLinesFormatter` for operator visibility
- **MCP protocol sink bridge** -- LogTape -> `notifications/message` with level caps (best-effort -- see client adoption gap below)
- **Per-request propagation** -- `withContext()` + `AsyncLocalStorage` for correlation IDs
- **fingersCrossed pattern** -- silent on success, full trace dump on failure via `fingersCrossed` + `isolateByContext`
- **Category hierarchy** -- `mcp.lifecycle`, `mcp.tools.tsc_check`, `mcp.transport`
- **Graceful shutdown** -- `dispose()` on SIGTERM/SIGINT
- **`setLevel` handler** -- respond to client `logging/setLevel` requests, default to `warning`+ if never received

### Research Insights

#### Bun-specific stderr WritableStream (gotcha)

LogTape's `getStreamSink()` requires a Web `WritableStream`, but `Bun.stderr` is not one natively. A manual adapter is required:

```typescript
import { getStreamSink, jsonLinesFormatter } from '@logtape/logtape'
import type { FileSink } from 'bun'

let writer: FileSink | undefined
const stderrStream = new WritableStream({
  start() { writer = Bun.stderr.writer() },
  write(chunk) { writer?.write(chunk) },
  close() { writer?.close() },
  abort() {},
})

const stderrJsonlSink = getStreamSink(stderrStream, {
  formatter: jsonLinesFormatter,
})
```

**Gotcha**: The LogTape docs have a copy-paste artifact naming the variable `stdout` -- ensure you target `Bun.stderr.writer()`.

#### LogTape configure() -- critical requirement

`contextLocalStorage` MUST be passed to `configure()`. Without it, `withContext()` silently does nothing -- this is the #1 LogTape footgun:

```typescript
import { AsyncLocalStorage } from 'node:async_hooks'
import { configure, fingersCrossed } from '@logtape/logtape'

await configure({
  contextLocalStorage: new AsyncLocalStorage(), // REQUIRED for withContext()
  sinks: {
    stderrFC: fingersCrossed(stderrJsonlSink, {
      triggerLevel: 'warning',
      bufferLevel: 'debug',
      maxBufferSize: 200,
      isolateByCategory: 'descendant',
      isolateByContext: {
        keys: ['requestId'],
        maxContexts: 50,
        bufferTtlMs: 60_000,
        cleanupIntervalMs: 30_000,
      },
    }),
    mcpProtocol: mcpProtocolSink,
  },
  loggers: [
    { category: ['mcp'], sinks: ['stderrFC'], lowestLevel: 'debug' },
    { category: ['mcp'], sinks: ['mcpProtocol'], lowestLevel: 'warning' },
  ],
})
```

#### Category hierarchy

LogTape uses array-based categories with parent-child inheritance. Child categories inherit parent config unless overridden:

```
["mcp"]                          // root -- catches all MCP logs
["mcp", "lifecycle"]             // server start/stop/connect
["mcp", "tools"]                 // all tool invocations
["mcp", "tools", "tsc_check"]   // specific tool
["mcp", "transport"]             // stdio transport layer
```

#### Level mapping: LogTape -> MCP (RFC 5424)

| LogTape Level | MCP Level   | Notes |
|---------------|-------------|-------|
| `trace`       | `debug`     | MCP has no trace; demote |
| `debug`       | `debug`     | Direct match |
| `info`        | `info`      | Direct match |
| `warning`     | `warning`   | Direct match |
| `error`       | `error`     | Direct match |
| `fatal`       | `critical`  | MCP has no fatal; promote |

MCP also has `notice`, `alert`, `emergency` with no LogTape equivalents. The `logging/setLevel` handler must map these to the nearest LogTape level.

#### MCP protocol sink -- connection guard required

The MCP server must declare `{ capabilities: { logging: {} } }` and the sink must guard against pre-connection calls:

```typescript
import type { LogRecord, Sink } from '@logtape/logtape'

const LOGTAPE_TO_MCP: Record<string, string> = {
  trace: 'debug', debug: 'debug', info: 'info',
  warning: 'warning', error: 'error', fatal: 'critical',
}

function createMcpProtocolSink(server: McpServer): Sink {
  let connected = false

  // Track connection state
  const origConnect = server.connect.bind(server)
  server.connect = async (transport) => {
    await origConnect(transport)
    connected = true
  }

  return (record: LogRecord) => {
    if (!connected) return // silently drop pre-connection logs

    server.server.sendLoggingMessage({
      level: LOGTAPE_TO_MCP[record.level] ?? 'info',
      logger: record.category.join('.'),
      data: { message: record.message.join(''), ...record.properties },
    })
  }
}
```

**Key considerations:**
- Default to `warning`+ to avoid flooding the client/LLM with debug noise
- Respect `logging/setLevel` requests from the client
- Inside tool handlers, use `ctx.mcpReq.log()` for request-scoped logging
- Outside handlers, use `server.server.sendLoggingMessage()` for lifecycle events

#### `notifications/message` client adoption gap (Inspector #610)

**Critical finding:** MCP Inspector issue #610 revealed that servers following the spec strictly produce **zero log output** until receiving an explicit `setLevel` request -- and most clients never send one. The SDK examples advertise the `logging` capability without implementing a `setLevel` handler, so every developer copying them hits silent failures.

**Implication for this plan:** Treat `notifications/message` as a best-effort bonus layer. stderr JSONL is the reliable operator channel. The protocol sink should:
1. Default to `warning`+ even if no `setLevel` is received
2. Implement a `setLevel` handler for well-behaved clients
3. Never be the only observability channel -- stderr JSONL must always work independently

#### fingersCrossed -- novel in MCP space

No MCP server builders publicly describe implementing fingersCrossed/buffered-flush-on-error. The closest analogs: MCPcat's "buffer logs, publish to OTLP" model, and the general operator guidance to "log full error details server-side without exposing them to clients."

If we build this, we'd be setting a pattern, not following one. The pattern is well-established in PHP/Symfony (Monolog's canonical `fingers_crossed` handler) but has not propagated into the MCP TypeScript ecosystem.

#### fingersCrossed memory management

MCP tool calls are short-lived (100ms-30s), so conservative settings work:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| `maxBufferSize` | 200 | Tool calls don't generate thousands of logs |
| `maxContexts` | 50 | Concurrent MCP tool calls are rare |
| `bufferTtlMs` | 60_000 | 1 min is generous for a tool call |
| `cleanupIntervalMs` | 30_000 | Check expired every 30s |

**Gotcha:** Errors during fingersCrossed buffer flushing are silently ignored by LogTape. Add explicit error handling around critical flush paths.

#### Per-request correlation with withContext()

```typescript
import { withContext, getLogger } from '@logtape/logtape'

const logger = getLogger(['mcp', 'tools'])

async function handleToolCall(toolName: string, args: unknown) {
  const requestId = crypto.randomUUID()

  return withContext({ requestId, tool: toolName }, async () => {
    logger.debug('Tool call received', { args })

    try {
      const result = await executeTool(toolName, args)
      logger.info('Tool call succeeded')
      // fingersCrossed discards buffered debug logs on success
      return result
    } catch (error) {
      logger.error('Tool call failed', { error: String(error) })
      // fingersCrossed flushes ALL buffered logs for THIS requestId only
      throw error
    }
  })
}
```

**Critical**: Never use `enterWith()` in long-lived servers -- it leaks context globally. Only `withContext()` (which uses `run()` internally) scopes correctly.

#### Shutdown ordering

`dispose()` MUST be called BEFORE `server.close()` to ensure fingersCrossed buffers flush their final logs before the transport disconnects:

```typescript
import { dispose } from '@logtape/logtape'

let shuttingDown = false
const shutdown = async () => {
  if (shuttingDown) return
  shuttingDown = true

  await dispose()       // flush all pending log writes FIRST
  await server.close()  // then close transport
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
```

#### Testing strategies

**1. Stdout contamination test** -- verify no logging leaks to stdout:

```typescript
test('logging does not write to stdout', async () => {
  const stdoutSpy = spyOn(process.stdout, 'write')
  const result = await callTool(client, 'tsc_check', { path: '.' })

  for (const call of stdoutSpy.mock.calls) {
    const output = call[0].toString()
    expect(() => JSON.parse(output)).not.toThrow()
    expect(JSON.parse(output)).toHaveProperty('jsonrpc', '2.0')
  }
  stdoutSpy.mockRestore()
})
```

**2. stderr JSONL structure test** -- each line is valid JSON:

```typescript
test('logging writes JSONL to stderr', async () => {
  const chunks: string[] = []
  const spy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(chunk.toString())
    return true
  })

  await callToolWithError(client, 'tsc_check', { path: '/nonexistent' })

  const lines = chunks.join('').trim().split('\n')
  for (const line of lines) {
    const parsed = JSON.parse(line)
    expect(parsed).toHaveProperty('level')
    expect(parsed).toHaveProperty('category')
  }
  spy.mockRestore()
})
```

**3. fingersCrossed behavior test** -- silent on success, flush on failure:

```typescript
test('fingersCrossed: silent on success, flush on failure', async () => {
  const chunks: string[] = []
  const spy = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    chunks.push(chunk.toString())
    return true
  })

  // Successful call -- should produce no stderr
  await callTool(client, 'tsc_check', { path: validPath })
  expect(chunks).toHaveLength(0)

  // Failing call -- should flush buffered debug + error
  await callTool(client, 'tsc_check', { path: invalidPath })
  const logs = chunks.flatMap(c => c.trim().split('\n')).map(JSON.parse)
  expect(logs.some(l => l.level === 'debug')).toBe(true)
  expect(logs.some(l => l.level === 'error')).toBe(true)

  spy.mockRestore()
})
```

**4. MCP protocol sink test** -- via InMemoryTransport:

```typescript
test('error logs forwarded as MCP notifications', async () => {
  const notifications: any[] = []
  clientTransport.onmessage = (msg) => {
    if (msg.method === 'notifications/message') notifications.push(msg.params)
  }

  await callToolWithError(client, 'tsc_check', { path: '/bad' })

  expect(notifications.some(n => n.level === 'error')).toBe(true)
  expect(notifications.every(n => typeof n.logger === 'string')).toBe(true)
})
```

## Three-Tier Error Model

MCP servers benefit from a clean separation of error tiers:

| Tier | Type | Example | Handling |
|------|------|---------|----------|
| 1 | Transport | Connection/stdio failures | Automatic reconnect or exit |
| 2 | Protocol | JSON-RPC violations | SDK handles; log at `error` |
| 3 | Application | Business logic (`TscToolError`) | `isError: true` + sanitized message to client, full context to stderr |

Phase C's `TscToolError` with `ToolErrorCode` already handles tier 3. Phase D adds structured logging across all three tiers.

**Key principle:** Never leak internals to clients. `isError: true` with sanitized messages; full structured context to operator logs only.

## MCP Observability Ecosystem (context)

The observability tooling landscape for MCP servers is rapidly evolving:

| Tool | Approach | Status |
|------|----------|--------|
| **MCPcat** | OTLP/Datadog/Sentry export, session-to-trace mapping | MIT, active (49 pts on r/mcp) |
| **Sentry MCP** | One-line SDK integration for MCP servers | Production (launched Aug 2025) |
| **Pydantic Logfire** | Logs/traces/metrics as queryable MCP tools | Active |
| **FastMCP** | Built-in OpenTelemetry support | Baked in |
| **DIY Loki/Grafana** | Self-hosted log pipeline via MCP | Community pattern |

**Our approach:** Library-level logging (LogTape + fingersCrossed) is complementary to these pipeline tools. Phase D provides the structured log output that MCPcat or Sentry could consume as a future Stage 3, but works standalone without external dependencies.

## Acceptance Criteria

- [x] Response layer owned locally with behavior parity
- [x] No core response/formatting imports remain
- [x] Zero stdout contamination from logging (tested with stdout spy)
- [x] stderr JSONL sink operational with `jsonLinesFormatter` (verify API name against v2.x)
- [x] MCP protocol sink bridge with level caps (default `warning`+, respects `logging/setLevel`)
- [x] Server declares `{ capabilities: { logging: {} } }`
- [x] MCP protocol sink guards against pre-connection `sendLoggingMessage` calls
- [x] `setLevel` handler implemented -- defaults to `warning`+ if client never sends `setLevel`
- [x] `contextLocalStorage: new AsyncLocalStorage()` passed to `configure()`
- [x] Per-request isolation verified under concurrent calls via `withContext()` + `isolateByContext`
- [x] `fingersCrossed` pattern: silent on success, full trace on failure
- [x] fingersCrossed memory bounds configured (`maxBufferSize`, `maxContexts`, `bufferTtlMs`)
- [x] Graceful logger disposal: `dispose()` called before `server.close()` on SIGTERM/SIGINT
- [x] Bun-specific `WritableStream` adapter for `Bun.stderr`
- [x] Level mapping covers LogTape->MCP and handles `logging/setLevel` with MCP-only levels
- [x] No use of `enterWith()` -- only `withContext()` for scoped context propagation
- [x] LogTape pinned to `@logtape/logtape@^2.0.4`
- [x] Logging integration tests pass (stdout contamination, JSONL structure, fingersCrossed behavior, MCP notifications)

## Gotchas Checklist

| Area | Gotcha | Impact |
|------|--------|--------|
| LogTape + Bun | Must construct `WritableStream` manually for `Bun.stderr` | Silent failure if wrong |
| LogTape | Must pass `contextLocalStorage` to `configure()` | `withContext()` silently no-ops |
| LogTape | `jsonLinesFormatter` name may differ in v2.x docs | Verify against JSR API |
| LogTape | fingersCrossed flush errors are silently ignored | Add explicit error handling |
| LogTape | GC-reset bug in versions < 2.0.4 | Pin to ^2.0.4 |
| MCP SDK | `sendLoggingMessage` only works after `connect()` | Throws if called early |
| MCP SDK | Need `{ capabilities: { logging: {} } }` in server config | Clients reject notifications |
| MCP SDK | Inside handlers: `ctx.mcpReq.log()`. Outside: `server.server.sendLoggingMessage()` | Two APIs for same thing |
| MCP spec | Servers produce zero output until client sends `setLevel` | Most clients never send it (Inspector #610) |
| fingersCrossed | Buffer memory grows without `maxBufferSize` | OOM on long-running processes |
| fingersCrossed | Need `isolateByContext` for per-request isolation | One error flushes all buffers |
| Level mapping | LogTape has no `notice`/`alert`/`emergency` | Handle in `logging/setLevel` |
| Level mapping | LogTape `fatal` -> MCP `critical` | Not 1:1 name match |
| stdout | Any `console.log` corrupts MCP protocol | Hard to debug; test explicitly |
| dispose | Must call before `server.close()` | Buffered logs lost otherwise |
| AsyncLocalStorage | Never use `enterWith()` in servers | Leaks context globally |

## Sources

### Specifications and documentation
- **MCP Logging spec (2025-03-26):** [modelcontextprotocol.io](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/logging)
- **LogTape sinks:** [github.com/dahlia/logtape](https://github.com/dahlia/logtape/blob/main/docs/manual/sinks.md)
- **LogTape changelog:** [logtape.org/changelog](https://logtape.org/changelog)
- **LogTape comparison:** [logtape.org/comparison](https://logtape.org/comparison) -- benchmark data
- **MCP SDK logging issues:** [SDK #175](https://github.com/modelcontextprotocol/typescript-sdk/issues/175), [SDK #311](https://github.com/modelcontextprotocol/typescript-sdk/issues/311)
- **MCP Inspector #610:** [github.com/modelcontextprotocol/inspector/issues/610](https://github.com/modelcontextprotocol/inspector/issues/610) -- `setLevel` required before logs emit
- **Bun AsyncLocalStorage:** [bun.com/reference/node/async_hooks/AsyncLocalStorage](https://bun.com/reference/node/async_hooks/AsyncLocalStorage)
- **Monolog fingersCrossed (canonical):** [github.com/Seldaek/monolog](https://github.com/Seldaek/monolog/blob/main/src/Monolog/Handler/FingersCrossedHandler.php)

### Community intelligence
- **@zeeg MCP migration:** [x.com/zeeg](https://x.com/zeeg/status/2021690203300331559) -- *"migrated to LogTape on the MCP service"*
- **@mattpocockuk stdio trap:** [x.com/mattpocockuk](https://x.com/mattpocockuk/status/1899049658883645798) -- 432 likes, *"you can't console.log in MCP servers"*
- **@hongminhee Sentry milestone:** [x.com/hongminhee](https://x.com/hongminhee/status/2009547080336085304) -- 21 likes, 10 reposts
- **Sentry LogTape guide:** [blog.sentry.io](https://blog.sentry.io/trace-connected-structured-logging-with-logtape-and-sentry/)
- **MCPcat monitoring:** [reddit.com/r/mcp](https://www.reddit.com/r/mcp/comments/1n2dyq2) -- 49 pts, MIT-licensed OTLP
- **MCP error handling:** [mcpcat.io](https://mcpcat.io/guides/error-handling-custom-mcp-servers/) -- three-tier error model
- **MCP debugging guide:** [mcpevals.io](https://www.mcpevals.io/blog/debugging-mcp-servers-tips-and-best-practices)
- **MCP logging tutorial:** [mcpevals.io](https://www.mcpevals.io/blog/mcp-logging-tutorial)

### Origin
- **Brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md)
- **Research:** [LogTape MCP observability](https://github.com/user/side-quest-marketplace/docs/research/2026-03-04-logtape-mcp-server-observability.md)
