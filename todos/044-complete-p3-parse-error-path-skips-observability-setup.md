---
status: complete
priority: p3
issue_id: "044"
tags: [code-review, observability, hooks, cli]
dependencies: []
---

# Parse Error Path Skips Observability Setup

## Problem Statement

`runCli()` calls `parseCommand()` before `setupObservability()`. On subcommand parse failures, metrics emission in `finally` can run without configured sinks.

## Findings

- Location: `packages/claude-hooks/hooks/index.ts`.
- `setupObservability()` is invoked after `parseCommand`.
- `emitMetric('hook.latency.totalMs', ...)` is always called in `finally`.

## Proposed Solutions

### Option 1: Initialize observability before parse (Recommended)
**Approach:** Move `setupObservability()` before `parseCommand`.
**Pros:** Ensures consistent metrics path.  
**Cons:** Slight startup overhead even for bad argv.  
**Effort:** Small  
**Risk:** Low

### Option 2: Guard metric emission when not initialized
**Approach:** Track readiness and no-op intentionally with explicit comment.
**Pros:** Minimal behavior change.  
**Cons:** Keeps missing telemetry on parse failures.  
**Effort:** Small  
**Risk:** Low

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/index.ts`

## Acceptance Criteria
- [ ] Parse failures still produce observability events.
- [ ] No regressions in stdout safety behavior.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged initialization ordering gap.

