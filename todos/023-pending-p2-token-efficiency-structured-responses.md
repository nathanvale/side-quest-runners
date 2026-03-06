---
status: pending
priority: p2
issue_id: "023"
tags: [token-efficiency, toon, json, mcp, structured-content, hooks, dx]
dependencies: []
---

# 023: Reduce Token Consumption in MCP Structured Responses

## Research

See [Arena: TOON vs JSON for Structured Responses](../docs/research/2026-03-06-toon-vs-json-structured-responses.md)

## Problem Statement

MCP tool responses from bun-runner, biome-runner, and tsc-runner consume unnecessary
context tokens due to:

1. **Repeated keys in uniform arrays** -- diagnostics/failures repeat `file`, `line`,
   `message`, `code`, `severity`, `suggestion` for every item
2. **Null field padding** -- `suggestion: null` sent 11x when there are no suggestions
3. **Stack trace bloat** -- multi-line async stacks in test failures (mostly boilerplate)
4. **Hook/MCP duplication** -- biome-ci and bun-test-ci hooks inject structured JSON
   that overlaps with the MCP tool response (same errors appear twice in context)
5. **Redundant file paths** -- when all items come from the same file, the path repeats
   per item

## Findings

### Local spike (2026-03-06)

Ran all three MCP tools against intentional error files:

- **biome_lintCheck** (11 diagnostics): 6 keys x 11 items = 66 repeated keys, 11x
  `suggestion: null`, 11x identical `file` path
- **bun_testFile** (7 failures): 4 keys x 7 items = 28 repeated keys, 7x identical
  `file` path, multi-line stack traces per failure
- **tsc_check**: showed 0 errors (tsconfig excluded spike dir), but the shape is
  5 keys x N errors with the same pattern

### Hook overlap observed

When writing a file with errors, context receives:
- biome-ci hook: 20 diagnostic objects as JSON
- biome MCP tool response: 11 diagnostic objects as JSON
- bun-test-ci hook: 30+ lines of pass/fail output
- bun MCP tool response: structured failures as JSON

Same errors, twice, in different formats.

### Arena research (TOON vs JSON)

Full adversarial research scored Team B (Stay with JSON) 16/25 vs Team A (Pro-TOON)
15/25. TOON is viable but premature -- simpler wins should come first.

## Proposed Solutions

### Option A: Zero-dependency JSON cleanup (recommended first)

**Effort:** 1-2 days | **Risk:** Low | **Savings:** ~20-30% estimated

1. Strip null/undefined fields from structured output
2. Truncate stack traces to top frame in text output
3. Deduplicate `file` when all items share the same path (group by file)
4. Audit and deduplicate hook vs MCP response overlap

**Pros:** No new dependencies, backward compatible, improves all format modes
**Cons:** Smaller savings than TOON for tabular data

### Option B: Add TOON response_format (Phase 2)

**Effort:** 2-3 days | **Risk:** Medium | **Savings:** ~40% on arrays, per benchmarks

1. Add `@toon-format/toon` dependency (~7KB, zero transitive deps)
2. Add `'toon'` as third `response_format` option
3. TOON-encode `content[].text` only -- `structuredContent` stays JSON (MCP requires it)

**Pros:** Largest token savings on uniform arrays
**Cons:** New dependency, provisional spec (v3.0), limited IDE/debugging tooling,
model-dependent savings (weaker models may not benefit)

### Option C: Hook deduplication only (quick win)

**Effort:** Half day | **Risk:** Very low | **Savings:** ~50% on duplicated responses

1. When an MCP tool is called for the same check a hook already ran, suppress the
   hook output or make it reference the tool response
2. Or: make hooks aware of pending MCP calls and skip

**Pros:** Biggest single win for least effort
**Cons:** Only addresses duplication, not the per-item verbosity

## Recommended Action

Start with **Option A + Option C** (zero-dependency cleanup + hook deduplication).
Measure actual context savings. Revisit TOON (Option B) if savings are insufficient
after cleanup.

## Acceptance Criteria

- [ ] Null fields stripped from all three runner structured outputs
- [ ] Stack traces truncated to top frame in text output
- [ ] File path deduplicated when all items share same file
- [ ] Hook/MCP response overlap audited and documented
- [ ] Before/after token count comparison on realistic payloads
- [ ] All existing tests pass
- [ ] No breaking changes to `response_format: 'json'` or `'markdown'`

## Technical Details

**Affected files:**
- `packages/bun-runner/mcp/index.ts` -- formatTestSummary, createToolSuccess
- `packages/biome-runner/mcp/index.ts` -- formatLintSummary, formatLintFixResult, formatFormatCheckResult
- `packages/tsc-runner/mcp/index.ts` -- formatTscMarkdown, buildTscOutput
- Hook scripts in the marketplace plugin (biome-ci, bun-test-ci)

**Response shapes to optimize:**
- `TestFailure[]` -- `{file, message, line, stack}`
- `LintDiagnostic[]` -- `{file, line, message, code, severity, suggestion}`
- `TscError[]` -- `{file, line, col, code, message}`

## Resources

- [Research: TOON vs JSON Arena](../docs/research/2026-03-06-toon-vs-json-structured-responses.md)
- [TOON format spec](https://github.com/toon-format/toon)
- [MCP Issue #1798 - TOON support](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1798)
- [MCP Issue #1710 - configurable response format](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1710)

## Work Log

### 2026-03-06 - Initial investigation and arena research

**By:** Claude Code

**Actions:**
- Reviewed all three runner structured output shapes (TestFailure, LintDiagnostic, TscError)
- Ran adversarial arena research: 2 beat reporters (pro-TOON vs anti-TOON)
- Ran local spike with intentional errors across all three runners
- Observed hook/MCP response duplication in real context
- Scored arena: Team B (JSON) 16/25 vs Team A (TOON) 15/25
- Created research doc and this todo

**Learnings:**
- The biggest context waste is hook/MCP duplication, not JSON verbosity
- Runner output shapes are TOON's ideal case (uniform arrays) but savings are
  modest on small payloads (4-11 items typical)
- `structuredContent` must stay JSON per MCP spec -- TOON can only affect text
- Simpler cleanup (null stripping, stack truncation, file dedup) should come first
