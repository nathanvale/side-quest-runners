---
status: pending
priority: p2
issue_id: "024"
tags: [code-review, observability, hooks, reliability]
dependencies: []
---

# Hook Metrics Are Buffered and Not Emitted

## Problem Statement

`@side-quest/claude-hooks` emits metric events at `info`, but observability is configured with a `fingersCrossed` sink that only flushes on `warning+`. In normal successful hook runs, this means required metrics are not visible on stderr.

## Findings

- `setupObservability()` configures `fingersCrossed(..., { triggerLevel: 'warning' })` in [observability.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/observability.ts:24).
- Metrics are emitted via `metricsLogger.info(...)` in [observability.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/observability.ts:58).
- Runtime verification showed empty stderr during successful hook execution:
  - `printf ... | SQ_HOOK_DEDUP_ENABLED=1 bun packages/claude-hooks/hooks/index.ts posttool`
  - stdout contained hook JSON, stderr was empty.
- This conflicts with the plan’s observability requirement to track hook counters/latency on stderr.

## Proposed Solutions

### Option 1: Use a direct stderr sink for metrics logger

**Approach:** Route `['side-quest','hooks','metrics']` to a non-buffered stderr sink while keeping fingers-crossed for non-metric logs.

**Pros:**
- Preserves buffering for noisy logs
- Guarantees metric visibility

**Cons:**
- Slightly more config complexity

**Effort:** 1-2 hours

**Risk:** Low

---

### Option 2: Lower trigger level to `info`

**Approach:** Keep a single buffered sink but set trigger level so info logs flush.

**Pros:**
- Small code change

**Cons:**
- Can increase log volume and weaken buffer intent

**Effort:** <1 hour

**Risk:** Medium

## Recommended Action


## Technical Details

**Affected files:**
- [observability.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/observability.ts)
- [index.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/index.ts)

## Resources

- Plan: [2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md](/Users/nathanvale/code/side-quest-runners/docs/plans/2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md)
- Known pattern: [mcp-tool-discoverability-ab-benchmark.md](/Users/nathanvale/code/side-quest-runners/docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md)

## Acceptance Criteria

- [ ] Successful hook run emits `hook.events.total` and `hook.latency.totalMs` on stderr
- [ ] No non-JSON output appears on stdout
- [ ] Existing tests pass and smoke still succeeds

## Work Log

### 2026-03-07 - Review Finding Created

**By:** Codex

**Actions:**
- Reproduced hook run and captured stdout/stderr
- Traced sink configuration vs metric log level
- Drafted remediation options

**Learnings:**
- Buffered sink policy can silently suppress expected telemetry in short-lived CLIs

## Notes

