---
title: "Phase B: tsc-runner Contract Uplift"
type: feat
status: active
date: 2026-03-04
priority: p1
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
depends_on: [phase-a]
absorbs: [004, 012]
---

# Phase B: tsc-runner Contract Uplift

## Overview

Apply the approved contract artifacts to `tsc_check` -- description, title, outputSchema, annotations, TS error code extraction, compact JSON, em dash fix, and version sync. This makes `tsc_check` the gold-standard tool contract that other runners will copy in Phase E.

## Problem Statement

`tsc_check` has a minimal description that doesn't follow MCP best practices for LLM routing. It lacks `title` and `outputSchema`. The parser discards TypeScript error codes (e.g., `TS2345`). JSON output is pretty-printed (wasting ~30% tokens). Em dashes appear in error output.

GitHub issues: #28, #29, #30, #31.

## Proposed Solution

Copy-paste the approved descriptions, schemas, titles, and annotations from the [contract artifacts doc](../research/2026-03-04-cross-runner-contract-artifacts.md). Add TS error code capture to regex. Switch to compact JSON. Fix em dash and version.

**Note:** If Phase A already sets up `title` and `outputSchema` during the `registerTool()` migration (which it naturally does), this phase focuses on the remaining items: description quality, error code regex, compact JSON, em dash fix, version sync, and contract tests.

### Changes

1. **Description** -- Apply what/when/returns/boundaries pattern from contract artifacts
2. **Title** -- `"TypeScript Type Checker"` (may already be set by Phase A)
3. **outputSchema** -- Zod schema matching actual JSON response shape (may already be set by Phase A)
4. **Annotations** -- Verify `readOnlyHint: true`, `idempotentHint: true` (already correct)
5. **Error code regex** -- Update `/^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/gm` to capture `TS\d+` as a field: `/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm`
6. **Compact JSON** -- Replace `JSON.stringify(data, null, 2)` with `JSON.stringify(data)`
7. **Em dash** -- Replace `--` in formatted output (the `--` literal, not the source code operator)
8. **Version sync** -- Read version from `package.json` at startup instead of hardcoding

### Absorbed Scope

From **todo 012** (missing outputSchema definitions):
- `bun_testCoverage.uncovered` field -- currently a formatted string (`"path (percentage%)"`) that mixes path and number. Split into `{ file: string, percent: number }`.
- `biome_lintFix.fixed` -- currently combines formatFixed + lintFixed into one number. Keep as single `fixed` count (the breakdown is implementation detail, not agent-relevant).
- All 7 outputSchema definitions validated against parser output. (Note: the 6 non-tsc schemas are applied in Phase E, but defined here for the contract artifacts.)

## Acceptance Criteria

- [ ] Description follows what/when/returns/boundaries from contract artifacts
- [ ] `title` set to `"TypeScript Type Checker"`
- [ ] `outputSchema` validates against actual response shape
- [ ] Annotations correct (`readOnlyHint: true`, `idempotentHint: true`)
- [ ] TS error codes captured in parsed output (e.g., `TS2345`) as `code` field
- [ ] JSON output compact (no pretty-print whitespace)
- [ ] No em dashes in output
- [ ] Server version read from `package.json` (not hardcoded)
- [ ] Contract tests: response validates against `outputSchema` at 100%
- [ ] `bun_testCoverage` uncovered field split into `{ file, percent }` in outputSchema definition (applied in Phase E)

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Phase B definition
- **Contract artifacts:** [docs/research/2026-03-04-cross-runner-contract-artifacts.md](../research/2026-03-04-cross-runner-contract-artifacts.md)
- GitHub Issues: #28, #29, #30, #31
