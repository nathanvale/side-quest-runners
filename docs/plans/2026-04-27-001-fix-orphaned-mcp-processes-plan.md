---
title: Prevent orphaned MCP runner processes after parent Claude Code session dies
type: fix
status: completed
date: 2026-04-27
---

# Prevent orphaned MCP runner processes after parent Claude Code session dies

## Overview

Add a parent-liveness watcher to all three MCP runners (`bun-runner`, `biome-runner`, `tsc-runner`) so they exit promptly when their parent Claude Code process (or sub-agent) dies without delivering SIGTERM. Today each runner relies on `transport.onclose` plus SIGINT/SIGTERM handlers, which do not reliably fire when the parent is killed abruptly or when sub-agents tear down. The result is dozens of orphaned `bun` processes accumulating across a working day.

## Problem Frame

Per [issue #56](https://github.com/nathanvale/side-quest-runners/issues/56):

- Each Claude Code session spawns ~4 bun MCP servers; **every sub-agent invocation spawns 4 more**.
- When the parent dies (or a sub-agent finishes), the runner is reparented to PID 1 and persists indefinitely.
- After a typical workday: 39 bun processes observed, only 8 belonging to the active session.
- Sub-agents are the dominant leak source — a session with 5–10 sub-agent calls leaks 20–40 processes.

The existing `transport.onclose` handler should detect stdio pipe closure but evidently does not fire in all parent-death scenarios on macOS. The runners need a defensive watcher that does not depend on the SDK transport noticing the disconnect.

## Requirements Trace

- R1. When the parent process of a runner dies, the runner exits within ~5 seconds (cleanly disposing the server and logger sinks).
- R2. The detection mechanism works on macOS (Apple Silicon, Bun v1.x) — the user's primary environment.
- R3. The watcher does not interfere with normal request/response operation under an active parent (no spurious exits, no measurable performance impact on hot paths).
- R4. All three first-party MCP runners receive the same fix with the same observable behavior.
- R5. The fix is verifiable without booting Claude Code — there is a deterministic test that proves a runner exits after its parent dies.

## Scope Boundaries

- Not changing the `x-api` MCP server (lives outside this repo). Fix in this repo applies only to `bun-runner`, `biome-runner`, `tsc-runner`.
- Not introducing a shared utility package. Per `.claude/CLAUDE.md`, each runner is intentionally self-contained; the parent-liveness watcher is duplicated across the three packages (small, ~30 lines).
- Not adding a Claude Code `Stop` lifecycle hook. The user-installed harness is out of scope; the runners must defend themselves.
- Not changing the existing SIGINT/SIGTERM handlers or `transport.onclose` shutdown path — those remain as the primary path. The watcher is a backstop.

---

## Context & Research

### Relevant Code and Patterns

- `packages/bun-runner/mcp/index.ts:1143-1180` — `startBunServer` shutdown wiring (canonical pattern; biome and tsc are near-identical).
- `packages/biome-runner/mcp/index.ts:1222-1260` — same pattern.
- `packages/tsc-runner/mcp/index.ts:1110-1148` — same pattern.
- `packages/bun-runner/mcp/index.test.ts` — bun:test structure (unit + integration via `InMemoryTransport`).
- `scripts/smoke/run-smoke.ts` — subprocess smoke-test harness that spawns the built binary via `StdioClientTransport`. The new lifecycle test fits naturally as a smoke-style subprocess test.

### Institutional Learnings

- `docs/solutions/` is mostly empty (only `integration-issues/`); no prior art for this class of fix.

### External References

- Node.js `process.ppid` is available on Bun and reflects the current parent. After reparenting to init, `ppid === 1` on Unix.
- POSIX `prctl(PR_SET_PDEATHSIG)` is Linux-only — unavailable on macOS, so it cannot be the primary mechanism.
- The MCP TypeScript SDK's `StdioServerTransport.onclose` fires when stdin emits `end`. In practice this is unreliable when the parent is SIGKILL'd: the kernel closes the pipe but Bun's stdin readable stream does not always surface the `end` event before another I/O wakeup. PPID polling is the standard fallback.

---

## Key Technical Decisions

- **PPID polling, not stdin watching.** `setInterval(() => { if (process.ppid === 1) shutdown() }, 5000)` is the simplest, most reliable mechanism on macOS. It catches every parent-death scenario regardless of how the parent died and regardless of whether stdin EOF was delivered.
- **5-second poll interval.** Balances responsiveness (orphans gone within ~5s) against overhead (one syscall per 5s is negligible). Configurable via `MCP_PARENT_CHECK_MS` env var for tests. Parsing rules: `<= 0` disables the watcher entirely; unparseable / empty / `NaN` falls back to the 5000ms default; positive values are clamped to a minimum of 50ms to prevent event-loop saturation.
- **`unref()` the timer.** The interval handle must not keep the event loop alive on its own — otherwise it would prevent clean shutdown via the existing paths.
- **Initial PPID capture.** Capture `process.ppid` at startup; if it ever changes (including to 1), trigger shutdown. This catches reparenting even if init's PID weren't 1 in some exotic environment, and is more semantically honest than hard-coding `=== 1`.
- **Reuse the existing `shutdown()` function.** No new shutdown path. The watcher just calls the same function as SIGTERM/onclose, so logger disposal and `server.close()` already happen.
- **Duplicate across the three runners.** Each runner is self-contained per repo policy. The watcher is ~30 lines; a shared package is not justified.

---

## Open Questions

### Resolved During Planning

- **Should the watcher be a shared utility?** No. Repo policy keeps each runner self-contained.
- **Linux-specific signal mechanism?** No. macOS is the primary environment and `prctl` is not available.
- **Touch x-api?** No. Out of repo.

### Deferred to Implementation

- None. The existing `shuttingDown` flag in `shutdown()` already guarantees re-entry safety, so a timer tick concurrent with a signal handler is a non-issue. No new deferred unknowns.

---

## Implementation Units

- U1. **Add parent-liveness watcher to bun-runner**

**Goal:** Make `bun-runner` exit within ~5s when its parent dies.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `packages/bun-runner/mcp/index.ts`
- Modify: `packages/bun-runner/mcp/index.test.ts`

**Approach:**
- Inside `startBunServer`, after the existing transport/signal wiring, capture `const initialPpid = process.ppid`.
- Read poll interval from `process.env.MCP_PARENT_CHECK_MS` per the parsing rules in Key Technical Decisions (default 5000; `<= 0` disables; unparseable falls back to default; positive values clamped to a 50ms minimum).
- `setInterval` that compares `process.ppid` to `initialPpid` (or to `1`) and calls the existing `shutdown()` when divergent.
- Call `.unref()` on the interval handle so it never keeps the event loop alive on its own.
- Log a single `lifecycleLogger.info` line on detection, including the observed PPID, before invoking `shutdown()`.

**Patterns to follow:**
- Existing `shutdown()` in `startBunServer` (`packages/bun-runner/mcp/index.ts:1149-1164`) — idempotent guard already in place.
- `lifecycleLogger` usage already established in the same function.

**Test scenarios:**
- Happy path: `startBunServer` returns normally and the interval is registered (spy `setInterval` and assert the returned handle had `.unref()` called).
- Edge case: `MCP_PARENT_CHECK_MS=0` (and any negative value) skips watcher registration entirely.
- Edge case: `MCP_PARENT_CHECK_MS` set to a non-numeric / empty / `NaN` string falls back to the 5000 default.
- Edge case: `MCP_PARENT_CHECK_MS=1` is clamped up to the 50ms minimum (assert the value passed to `setInterval`).
- Edge case: invoking the interval callback when `process.ppid` is unchanged does not trigger shutdown.
- Integration: invoking the interval callback after stubbing `process.ppid` to `1` calls `shutdown()` exactly once even when invoked twice in quick succession (idempotency).

**Verification:**
- Unit tests pass via `bun_testFile` for `packages/bun-runner/mcp/index.test.ts`.
- `tsc_check` passes for the package.

---

- U2. **Add parent-liveness watcher to biome-runner**

**Goal:** Mirror U1 in `biome-runner` with identical behavior.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1 (establishes the canonical shape)

**Files:**
- Modify: `packages/biome-runner/mcp/index.ts`
- Modify: `packages/biome-runner/mcp/index.test.ts`

**Approach:**
- Apply the U1 change verbatim inside `startBiomeServer` (`packages/biome-runner/mcp/index.ts:1222-1260`).
- Keep the literal code shape identical to bun-runner so future readers can diff the three implementations and see they match.

**Patterns to follow:**
- The version landed in U1.

**Test scenarios:**
- Same four scenarios as U1, adapted to `startBiomeServer`.

**Verification:**
- Unit tests pass for `packages/biome-runner/mcp/index.test.ts`.
- `tsc_check` passes.

---

- U3. **Add parent-liveness watcher to tsc-runner**

**Goal:** Mirror U1 in `tsc-runner`.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `packages/tsc-runner/mcp/index.ts`
- Modify: `packages/tsc-runner/mcp/index.test.ts`

**Approach:**
- Apply the U1 change verbatim inside `startTscServer` (`packages/tsc-runner/mcp/index.ts:1110-1148`).

**Patterns to follow:**
- The version landed in U1.

**Test scenarios:**
- Same four scenarios as U1, adapted to `startTscServer`.

**Verification:**
- Unit tests pass for `packages/tsc-runner/mcp/index.test.ts`.
- `tsc_check` passes.

---

- U4. **End-to-end orphan-detection smoke test**

**Goal:** Prove the fix works against a *built* binary in a real subprocess — not just the unit-level interval callback.

**Requirements:** R1, R2, R5

**Dependencies:** U1, U2, U3 (all binaries need the watcher built)

**Files:**
- Create: `scripts/smoke/orphan-detection.test.ts` (or extend `scripts/smoke/run-smoke.ts` with a new case — choose during implementation)
- Modify: `package.json` if a new script entry is needed.

**Approach:**
- For each of the three built MCP server binaries (`packages/*/dist/index.js`):
  1. Spawn an intermediate `bun -e` process. The intermediate `Bun.spawn`s the runner binary with **`stdio: ['ignore', 'ignore', 'ignore']`** (or equivalently a held-open FIFO that the test process owns) so the runner's stdin is *not* coupled to the intermediate. This is load-bearing: it ensures killing the intermediate does not close the runner's stdin, which would fire `transport.onclose` via the existing path and mask whether the watcher actually triggered the exit.
  2. The intermediate writes the runner's PID to its stdout (which the test reads), then idles.
  3. Set `MCP_PARENT_CHECK_MS=200` on the runner so the test runs in ~1s.
  4. Test SIGKILLs the intermediate's PID directly (not the process group). Runner reparents to PID 1.
  5. Poll `kill(runnerPid, 0)` until it throws ESRCH, with a 5s timeout.
  6. Assert the runner exited.
- Run the new test as part of `bun test:smoke` so `bun run validate` covers it.

**Patterns to follow:**
- `scripts/smoke/run-smoke.ts` for spawning built binaries and waiting on lifecycle events.

**Test scenarios:**
- Happy path: each of the three runners exits within 5s of intermediate-parent death (with `MCP_PARENT_CHECK_MS=200` and stdin detached).
- Negative control: with `MCP_PARENT_CHECK_MS=0` (watcher disabled) and stdin detached, the runner **stays alive** for at least 2s after the intermediate dies. This is the proof that the watcher — not `transport.onclose` — is the active mechanism in the happy-path test. If this scenario ever shows the runner exiting, the stdin detachment is leaking and the happy-path test is no longer trustworthy.
- Edge case: with `MCP_PARENT_CHECK_MS=10000` (much longer than the test window) and stdin detached, the runner stays alive for the duration of the test window — confirming the timer is the only path firing and the interval value is honored.

**Verification:**
- `bun test:smoke` passes locally.
- `bun run validate` passes.
- Manual sanity check: run a built runner under a shell, kill the shell, confirm the runner exits within ~5s.

---

## System-Wide Impact

- **Interaction graph:** Only the runner startup path is touched. No request handler, no tool, no transport internals.
- **Error propagation:** The watcher routes through the existing `shutdown()` function, so logger flush and `server.close()` already happen and any errors during disposal are already handled.
- **State lifecycle risks:** None — the watcher is idempotent via the existing `shuttingDown` guard.
- **API surface parity:** All three runners get the same change, preserving the convention that they evolve together.
- **Integration coverage:** The U4 smoke test is the integration backstop; unit tests cover the watcher logic in isolation.
- **Unchanged invariants:** The existing `transport.onclose` and SIGINT/SIGTERM shutdown paths are preserved unchanged. The watcher is additive.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `process.ppid` semantics differ across Bun versions or platforms. | Capture `initialPpid` at startup and compare against it; also treat `=== 1` as a death signal. Smoke test runs against the actual built binary on the user's platform. |
| 5s poll is too slow for users who notice orphans during rapid sub-agent churn. | `MCP_PARENT_CHECK_MS` env var lets users tune down to ~200ms if needed. Default is conservative. |
| Watcher fires during a brief reparenting window that legitimately ends with PPID 1 (e.g., daemonization). | Runners are not daemonized — they're stdio children of Claude Code. PPID 1 unambiguously means the parent is gone. |
| Smoke test is flaky on slow CI. | Use `MCP_PARENT_CHECK_MS=200` and a 5s wall-clock timeout — 25× headroom. |

---

## Sources & References

- Issue: [#56](https://github.com/nathanvale/side-quest-runners/issues/56)
- Related code: `packages/bun-runner/mcp/index.ts:1143`, `packages/biome-runner/mcp/index.ts:1222`, `packages/tsc-runner/mcp/index.ts:1110`
- Smoke harness: `scripts/smoke/run-smoke.ts`
