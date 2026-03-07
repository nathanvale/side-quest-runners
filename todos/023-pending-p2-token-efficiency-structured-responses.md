---
status: completed
priority: p2
issue_id: "023"
tags: [token-efficiency, toon, json, mcp, structured-content, hooks, dx]
dependencies: []
---

# 023: Reduce Token Consumption in MCP Structured Responses

## Enhancement Summary

**Deepened on:** 2026-03-06  
**Sections enhanced:** 9  
**Research lenses used:** architecture-strategist, performance-oracle, security-sentinel, agent-reliability-guardrails, cli-agent-reliability-auditor, pattern-recognition-specialist, spec-flow-analyzer, code-simplicity-reviewer, framework-docs-researcher, best-practices-researcher, learnings-researcher

### Key Improvements
1. Added explicit phased rollout with measurable go/no-go gates and rollback path.
2. Added concrete normalization contract for structured outputs that preserves JSON compatibility.
3. Added implementation/test matrix per runner package to reduce regression risk.

### New Considerations Discovered
- The largest near-term gain is still hook/MCP duplication removal; schema compaction should be shipped as a separate, independently measurable layer.
- `structuredContent` compatibility is a hard boundary; any text compaction strategy must not change machine-readable fields or field semantics without a version gate.

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

### Research Insights

**Best Practices:**
- Establish a fixed baseline corpus (small/medium/large payloads) and track both raw bytes and model-token estimates per tool/output mode before changing contracts.
- Separate optimization layers: (1) duplication suppression, (2) schema normalization, (3) optional text encoding strategy; measure each independently.

**Performance Considerations:**
- Optimize highest-frequency paths first (`response_format: 'json'`, diagnostics/failures arrays) before introducing optional formats.
- Keep output transformations linear-time with bounded allocations to avoid shifting cost from token usage to CPU/memory.

**Implementation Details:**
```ts
// Shape-preserving normalization pass (example)
function stripNullFields<T extends Record<string, unknown>>(obj: T): T {
  const entries = Object.entries(obj).filter(([, value]) => value !== null && value !== undefined)
  return Object.fromEntries(entries) as T
}
```

**Edge Cases:**
- Empty arrays and zero-count summaries must remain explicit (avoid accidental field removal that harms caller logic).
- Parse-fallback outputs (for tool failures) should stay verbose enough for remediation and debugging.

**References:**
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1710
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1798

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

### Research Insights

**Best Practices:**
- Normalize once at tool boundary (`createToolSuccess` call site) so all tools share the same compaction behavior and tests.
- Preserve semantic fields in `structuredContent`; only omit null/undefined and optionally introduce additive metadata for compaction (`commonFile`, `items`).
- Add a strict contract note: additive changes only in `json` mode unless major-version bump.

**Performance Considerations:**
- Target O(n) pass for diagnostics/failures with no deep cloning when unnecessary.
- Avoid repeated `JSON.stringify`/`JSON.parse` round-trips; operate on typed objects directly.

**Implementation Details:**
```ts
// File-path dedup pattern for homogeneous arrays
function compactByCommonFile<T extends { file: string }>(items: T[]) {
  if (items.length === 0) return { commonFile: null, items }
  const first = items[0]?.file
  const same = first && items.every((item) => item.file === first)
  if (!same) return { commonFile: null, items }
  return {
    commonFile: first,
    items: items.map(({ file: _ignored, ...rest }) => rest),
  }
}
```

**Edge Cases:**
- Mixed-file arrays must not be compacted into ambiguous shapes.
- Consumers that assume `file` on every element need compatibility handling (keep legacy shape by default or gate via explicit opt-in field).

**References:**
- https://bun.sh/docs/test
- https://biomejs.dev/reference/cli/

### Option B: Add TOON response_format (Phase 2)

**Effort:** 2-3 days | **Risk:** Medium | **Savings:** ~40% on arrays, per benchmarks

1. Add `@toon-format/toon` dependency (~7KB, zero transitive deps)
2. Add `'toon'` as third `response_format` option
3. TOON-encode `content[].text` only -- `structuredContent` stays JSON (MCP requires it)

**Pros:** Largest token savings on uniform arrays
**Cons:** New dependency, provisional spec (v3.0), limited IDE/debugging tooling,
model-dependent savings (weaker models may not benefit)

### Research Insights

**Best Practices:**
- Keep TOON scoped to `content[].text` only, with unchanged `structuredContent` JSON envelope.
- Add explicit feature flag and telemetry gate so TOON can be disabled quickly if client compatibility issues appear.
- Document TOON mode as optimization for model-facing readability, not machine contract.

**Performance Considerations:**
- Gains are workload-sensitive; measure across typical runner payload sizes (4-11 items) and stress cases before defaulting.
- Include decode/readability overhead in evaluation, not token metrics alone.

**Implementation Details:**
```ts
type ResponseFormat = 'json' | 'markdown' | 'toon'
// 'toon' affects content text only; structuredContent remains JSON object.
```

**Edge Cases:**
- Downstream tools that parse `content[].text` as JSON may break in TOON mode; guard with opt-in and clear docs.
- Need deterministic fallback to JSON text when TOON encode fails.

**References:**
- https://github.com/toon-format/toon
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1798

### Option C: Hook deduplication only (quick win)

**Effort:** Half day | **Risk:** Very low | **Savings:** ~50% on duplicated responses

1. When an MCP tool is called for the same check a hook already ran, suppress the
   hook output or make it reference the tool response
2. Or: make hooks aware of pending MCP calls and skip

**Pros:** Biggest single win for least effort
**Cons:** Only addresses duplication, not the per-item verbosity

### Research Insights

**Best Practices:**
- Introduce a deterministic dedup key (`tool + normalized path + command hash + time window`) shared between hook and MCP responses.
- Prefer suppression-with-pointer over silent drop (e.g., hook emits brief “see MCP tool result” marker).
- Keep dedup logic local to hook layer where possible to avoid coupling runner contracts to editor/runtime lifecycle behavior.

**Performance Considerations:**
- Time-windowed dedup cache should be bounded and TTL-based to prevent memory creep.
- False-positive dedup risk should be minimized with strong keys and command context.

**Implementation Details:**
```ts
// Conceptual dedup key material
const dedupKey = `${tool}:${realpath}:${operation}:${requestBucket}`
```

**Edge Cases:**
- Parallel invocations on the same file/path can interleave; dedup must be request-aware.
- Hook failure paths should still emit enough context when MCP tool call never occurs.

**References:**
- ../docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md

## Recommended Action

Start with **Option A + Option C** (zero-dependency cleanup + hook deduplication).
Measure actual context savings. Revisit TOON (Option B) if savings are insufficient
after cleanup.

### Research Insights

**Best Practices:**
- Execute as phased rollout with explicit gates:
  - Phase 1: Hook/MCP dedup only
  - Phase 2: JSON shape cleanup (null stripping + stack trimming + optional file dedup strategy)
  - Phase 3: Evaluate TOON as opt-in experimental format
- Require before/after benchmark artifacts committed to `docs/reports/` for each phase.

**Performance Considerations:**
- Use absolute and relative targets (e.g., median token reduction and p95 payload reduction).
- Track error triage time impact to ensure compaction does not degrade debuggability.

**Implementation Details:**
```md
Go/No-Go Gate (example):
- Phase passes if median token reduction >= 20%
- No regression in tool-call success rate
- No breaking changes in structuredContent schema
```

**Edge Cases:**
- If compaction harms readability/debuggability, rollback just the text compaction while keeping dedup.
- Keep fallback modes documented for support workflows.

## Acceptance Criteria

- [x] Null fields stripped from all three runner structured outputs
- [x] Stack traces truncated to top frame in text output
- [x] File path deduplicated when all items share same file
- [x] Hook/MCP response overlap audited and documented
- [x] Before/after token count comparison on realistic payloads
- [x] All existing tests pass
- [x] No breaking changes to `response_format: 'json'` or `'markdown'`
- [x] Phase-level benchmark report added with baseline + post-change metrics
- [x] Structured output contract snapshot tests added/updated for each runner
- [x] Rollback note documented for each phase (dedup, cleanup, optional TOON)

### Research Insights

**Best Practices:**
- Add explicit compatibility assertions in tests for `structuredContent` keys/types per tool.
- Include one stress fixture per runner to prevent regressions from only tiny-payload tests.

**Performance Considerations:**
- Acceptance should include p50 and p95 payload/token deltas, not only single-run anecdotal values.

**Edge Cases:**
- Tool-failure envelopes must remain actionable and include remediation hints where currently provided.

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

### Research Insights

**Best Practices:**
- Add shared local helper per package for:
  - null/undefined stripping
  - optional stack trimming for text format
  - optional homogeneous-file compaction
- Keep transformations close to existing formatting functions to minimize architectural drift in single-file server pattern.

**Implementation Details:**
```md
Per-runner checklist:
- bun-runner:
  - update formatTestSummary() stack rendering policy
  - add structured-output compaction before createToolSuccess()
- biome-runner:
  - compact diagnostics suggestion/file repetition
  - preserve lintFix remaining diagnostics contract
- tsc-runner:
  - compact errors array carefully; keep parse fallback diagnostics intact
```

```md
Test matrix additions:
- unit: compaction helpers (null stripping, shared file detection)
- integration: callTool json format returns expected schema
- regression: markdown output still actionable and line-referenced
```

**Edge Cases:**
- `line: 0` or `col: 0` should not be mistaken for missing fields.
- Optional fields like `remediationHint` must remain when present.

## Resources

- [Research: TOON vs JSON Arena](../docs/research/2026-03-06-toon-vs-json-structured-responses.md)
- [TOON format spec](https://github.com/toon-format/toon)
- [MCP Issue #1798 - TOON support](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1798)
- [MCP Issue #1710 - configurable response format](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1710)
- [Bun test docs](https://bun.sh/docs/test)
- [Biome CLI docs](https://biomejs.dev/reference/cli/)
- [TypeScript compiler options](https://www.typescriptlang.org/tsconfig)
- [Phase 1 benchmark report](../docs/reports/2026-03-06-token-efficiency-structured-output-phase1.md)

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

### 2026-03-06 - Phase 1 implementation completed

**By:** Codex (GPT-5)

**Actions:**
- Implemented null/undefined stripping in structured output for bun/biome/tsc runners
- Added JSON text compaction with shared-path dedup (`commonFile`) across all three runners
- Truncated bun markdown stack rendering to top frame
- Added/updated snapshot-style tests for compact output contracts in all three runner test suites
- Ran targeted runner tests, lint checks, and type-check validation
- Documented benchmark metrics and rollback plan in `docs/reports/2026-03-06-token-efficiency-structured-output-phase1.md`

**Learnings:**
- Shared file-path dedup plus null stripping yields substantial savings on realistic structured payload shapes
- Hook/MCP duplication remains the primary external optimization remaining and should be implemented in the marketplace hook layer
