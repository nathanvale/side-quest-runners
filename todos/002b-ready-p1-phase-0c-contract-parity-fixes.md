---
status: complete
priority: p1
issue_id: "002b"
tags: [mcp, bun-runner, biome-runner, contract, parity, bug]
dependencies: ["002"]
---

# Phase 0c: Contract Parity Fixes -- bun-runner failure semantics and biome-runner casing

## Problem Statement

The contract artifacts research (Phase 0b) and independent verification uncovered two implementation bugs that make the outputSchema contracts inaccurate. These must be fixed before contract uplift (Phase B) ships, otherwise the contracts would be wrong from day one.

1. **bun-runner throws on test failure** -- all 3 bun-runner tools throw when tests fail, converting structured diagnostic data into unstructured error text. This breaks agentic remediation loops: the agent loses file/line/message data and can't programmatically fix failures.

2. **biome-runner uses snake_case** -- `error_count`, `warning_count`, `unformatted_files` vs tsc-runner's camelCase (`errorCount`, `configPath`). Mixed conventions confuse agents consuming multiple tools in sequence.

## Findings

- `packages/bun-runner/mcp/index.ts:286` -- `bun_runTests` throws `new Error(text)` when `summary.failed > 0`
- `packages/bun-runner/mcp/index.ts:338` -- `bun_testFile` same pattern
- `packages/bun-runner/mcp/index.ts:382` -- `bun_testCoverage` same pattern
- `packages/biome-runner/mcp/index.ts:50` -- `LintSummary` interface uses `error_count`, `warning_count`
- `packages/biome-runner/mcp/index.ts:332` -- `formatFormatCheckResult` outputs `unformatted_files`
- MCP SDK issue #654 confirms `outputSchema` validation runs before `isError` check -- tools can't return structured errors when outputSchema is declared
- `tsc_check` already does this correctly: returns structured JSON for both success and error cases
- `biome check --reporter=json` confirmed to include formatting violations (category "format") in the current config

## Proposed Solutions

### Option 1: Fix both in a single PR (recommended)

**Approach:** Two focused changes in one PR:

1. **bun-runner:** Remove throw-on-failure, return structured JSON for all cases. Test failures are diagnostic results (like type errors), not tool failures. Reserve `isError: true` for actual tool failures (timeout, spawn error, invalid path).

2. **biome-runner:** Rename `error_count` -> `errorCount`, `warning_count` -> `warningCount`, `unformatted_files` -> `unformattedFiles` in the `LintSummary`/`LintDiagnostic` interfaces and all JSON output paths.

**Pros:**
- Small, focused scope -- no feature work, just correctness
- Unblocks accurate outputSchema contracts in Phase B
- bun-runner fix is the single highest-impact change for agent reliability

**Cons:**
- Breaking change for any consumers relying on snake_case keys (low risk -- internal tools only)
- Breaking change for consumers relying on `isError: true` for test failures (low risk -- agents should check `failed > 0` instead)

**Effort:** 2-3 hours

**Risk:** Low -- both are internal interfaces with no external consumers yet

## Recommended Action

Execute Option 1. This is the critical path for Phase B.

## Technical Details

**Affected files:**

bun-runner:
- `packages/bun-runner/mcp/index.ts` -- remove throw blocks at lines 286-291, 338-342, 382-392
- `packages/bun-runner/mcp/index.ts` -- ensure all code paths return formatted text (not throw)
- `packages/bun-runner/mcp/*.test.ts` -- update tests to assert structured failure payloads with `isError: false`

biome-runner:
- `packages/biome-runner/mcp/index.ts` -- rename `LintSummary` fields: `error_count` -> `errorCount`, `warning_count` -> `warningCount`
- `packages/biome-runner/mcp/index.ts` -- rename `unformatted_files` -> `unformattedFiles` in format check output
- `packages/biome-runner/mcp/*.test.ts` -- update tests for camelCase keys

**bun-runner fix pattern (before/after):**

Before:
```typescript
if (summary.failed > 0) {
    const error = new Error(text)
    ;(error as Error & { summary?: TestSummary }).summary = summary
    throw error
}
return text
```

After:
```typescript
return text  // always return -- failures are diagnostic data, not tool errors
```

## Resources

- [Contract artifacts research doc](/Users/nathanvale/code/side-quest-runners/docs/research/2026-03-04-cross-runner-contract-artifacts.md) -- "Implementation Actions Required" section
- [MCP SDK issue #654](https://github.com/modelcontextprotocol/typescript-sdk/issues/654) -- outputSchema vs isError ordering
- `packages/tsc-runner/mcp/index.ts` -- reference for correct pattern (returns structured JSON for both success and error)

## Acceptance Criteria

- [x] `bun_runTests` returns structured JSON with `isError: false` when tests fail
- [x] `bun_testFile` returns structured JSON with `isError: false` when tests fail
- [x] `bun_testCoverage` returns structured JSON with `isError: false` when tests fail
- [x] `biome_lintCheck` output uses camelCase: `errorCount`, `warningCount`
- [x] `biome_lintFix` output uses camelCase: `errorCount`, `warningCount`
- [x] `biome_formatCheck` output uses camelCase: `unformattedFiles`
- [x] All existing tests updated and passing
- [x] Existing 13 parser tests already assert structured failure payload shape (`passed`, `failed`, `total`, `failures[]` with `file`, `line`, `message`) -- no new tests needed since handlers now return parser output directly without throwing

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created from findings in Phase 0b deepening research (7 parallel review agents)
- Architecture-strategist, agent-native-reviewer, and pattern-recognition-specialist all independently flagged these as critical

**Learnings:**
- Test failures are diagnostic results, not tool failures -- same category as type errors
- The throw-on-failure pattern was the single highest-risk finding across all review agents
- snake_case in biome-runner is the only cross-runner inconsistency; tsc-runner and bun-runner already use camelCase

### 2026-03-04 - Implementation Complete

**By:** Claude Code

**Actions:**
- Removed throw-on-failure from all 3 bun-runner tool handlers (`bun_runTests`, `bun_testFile`, `bun_testCoverage`)
- Renamed `error_count` -> `errorCount`, `warning_count` -> `warningCount` in biome-runner `LintSummary` interface and all usages
- Renamed `unformatted_files` -> `unformattedFiles` in `formatFormatCheckResult`
- Updated biome-runner test assertions to use camelCase
- All 20 tests passing (13 bun-runner parser tests + 3 biome-runner parser tests + 4 tsc-runner tests)

**Learnings:**
- Handlers are closures inside `tool()` calls -- not independently unit-testable without extracting them
- The 13 existing parser tests already fully cover the structured payload shape that handlers now return directly
- `replace_all` edits trigger hook runs on intermediate states -- sequential multi-file renames cause transient test failures during editing
