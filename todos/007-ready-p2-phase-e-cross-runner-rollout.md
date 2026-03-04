---
status: ready
priority: p2
issue_id: "007"
tags: [mcp, bun-runner, biome-runner, parity, rollout]
dependencies: ["006"]
---

# Phase E: Cross-Runner Rollout

## Problem Statement

After `tsc-runner` has proven the gold-standard pattern through one stable release cycle, the same contract, reliability, and observability patterns must be applied to `bun-runner` (3 tools) and `biome-runner` (3 tools).

## Findings

**bun-runner (3 tools):**
- `bun_runTests`, `bun_testFile`, `bun_testCoverage`
- All have `readOnlyHint: true, destructiveHint: false`
- No `title`, `outputSchema`, or `idempotentHint`
- Descriptions need what/when/returns/boundaries rewrite

**biome-runner (3 tools):**
- `biome_lintCheck`, `biome_lintFix`, `biome_formatCheck`
- `biome_lintFix` correctly sets `destructiveHint: true`
- Others need annotation audit
- No `title` or `outputSchema`
- Descriptions need rewrite

## Proposed Solutions

### Option 1: Sequential rollout (bun-runner then biome-runner)

**Approach:** Apply the proven tsc-runner pattern to bun-runner first, verify parity, then biome-runner. Use the Phase 0b contract artifacts for descriptions/schemas/annotations. Apply the observability pattern from Phase D.

**Effort:** 4-6 hours per runner

**Risk:** Low (pattern is proven by this point)

## Recommended Action

To be filled during triage. Should only begin after tsc-runner is stable for one release cycle.

## Acceptance Criteria

- [ ] bun-runner: all 3 tools have description, title, outputSchema, annotations from Phase 0b
- [ ] bun-runner: compact JSON, no em dashes, version synced
- [ ] bun-runner: env allowlist, structured errors
- [ ] bun-runner: response layer and LogTape dual-channel logging
- [ ] biome-runner: all 3 tools have description, title, outputSchema, annotations from Phase 0b
- [ ] biome-runner: compact JSON, no em dashes, version synced
- [ ] biome-runner: env allowlist, structured errors
- [ ] biome-runner: response layer and LogTape dual-channel logging
- [ ] Cross-runner parity checklist fully green (all 13 capabilities across all 3 runners)

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase E
- Depends on Phase D (issue 006) -- tsc-runner must be stable first
