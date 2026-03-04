---
title: "Phase E: Cross-Runner Rollout"
type: feat
status: active
date: 2026-03-04
priority: p2
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
depends_on: [phase-d]
absorbs: [007, 017]
---

# Phase E: Cross-Runner Rollout

## Overview

Apply the proven tsc-runner pattern (contracts, reliability, observability) to `bun-runner` (3 tools) and `biome-runner` (3 tools). This is the final phase -- after this, all 13 capabilities on the cross-runner parity checklist are green across all 3 runners.

## Problem Statement

After Phases A-D, `tsc-runner` has the gold-standard MCP runner pattern. `bun-runner` and `biome-runner` still need:

- Contract uplift (descriptions, titles, outputSchema from Phase 0b artifacts)
- Reliability primitives (env allowlist, structured errors)
- Observability (response layer, LogTape dual-channel)

**Note:** Some contract parity work was already done in todo 002b (camelCase normalization, throw-on-failure removal). This phase builds on that foundation.

## Proposed Solution

Sequential rollout: bun-runner first, verify parity, then biome-runner. Use the tsc-runner implementation as the template.

### Per-Runner Scope

**bun-runner (3 tools: `bun_runTests`, `bun_testFile`, `bun_testCoverage`):**
- Apply descriptions, titles, outputSchema, annotations from contract artifacts
- Compact JSON output (no pretty-print)
- Env allowlist (filtered spawn env)
- Structured error codes (TIMEOUT, SPAWN_FAILURE, PATTERN_INVALID)
- Response layer and LogTape dual-channel logging
- Version sync with package.json
- Fix `bun_testCoverage.uncovered` mixed-type field: split `"path (percentage%)"` into `{ file: string, percent: number }`

**biome-runner (3 tools: `biome_lintCheck`, `biome_lintFix`, `biome_formatCheck`):**
- Apply descriptions, titles, outputSchema, annotations from contract artifacts
- Compact JSON output
- Env allowlist
- Structured error codes (SPAWN_FAILURE, PATH_NOT_FOUND)
- Response layer and LogTape dual-channel logging
- Version sync with package.json

### Absorbed Scope

From **todo 017** (biome_lintFix subprocess pattern):
- `biome_lintFix` currently runs 3 sequential subprocesses (format, lint fix, re-check) -- 3x slower than needed
- Evaluate combining into single `biome check --fix --formatter-enabled=true`
- If CLI supports it, optimize. If not, document as known limitation with timing data from Phase D observability.

## Cross-Runner Parity Checklist

| Capability | tsc-runner | bun-runner | biome-runner |
|---|---|---|---|
| Description quality (what/when/returns/boundaries) | Phase B | This phase | This phase |
| `title` present | Phase A | This phase | This phase |
| `outputSchema` present | Phase A | This phase | This phase |
| Compact JSON response | Phase B | This phase | This phase |
| Env allowlist | Phase C | This phase | This phase |
| Version sync with package | Phase B | This phase | This phase |
| No em dashes | Phase B | This phase | This phase |
| Structured error codes | Phase C | This phase | This phase |
| Correct annotations | Phase A | 002b | 002b |
| Contract tests | Phase B | This phase | This phase |
| Dual-channel logging | Phase D | This phase | This phase |
| Request isolation (fingersCrossed) | Phase D | This phase | This phase |
| Graceful logging shutdown | Phase D | This phase | This phase |

## Acceptance Criteria

### bun-runner
- [ ] All 3 tools have description, title, outputSchema, annotations from contract artifacts
- [ ] Compact JSON, no em dashes, version synced
- [ ] Env allowlist, structured errors
- [ ] Response layer and LogTape dual-channel logging
- [ ] `bun_testCoverage.uncovered` uses `{ file, percent }` instead of formatted string

### biome-runner
- [ ] All 3 tools have description, title, outputSchema, annotations from contract artifacts
- [ ] Compact JSON, no em dashes, version synced
- [ ] Env allowlist, structured errors
- [ ] Response layer and LogTape dual-channel logging
- [ ] `biome_lintFix` subprocess count optimized or documented with timing data

### Parity
- [ ] Cross-runner parity checklist fully green (all 13 capabilities across all 3 runners)

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Phase E definition
- **Contract artifacts:** [docs/research/2026-03-04-cross-runner-contract-artifacts.md](../research/2026-03-04-cross-runner-contract-artifacts.md)
- **Parity checklist:** Brainstorm "Cross-Runner Parity Checklist" section
