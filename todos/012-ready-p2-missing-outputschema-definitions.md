---
status: ready
priority: p2
issue_id: "012"
tags: [code-review, agent-native, mcp]
dependencies: []
---

# Missing outputSchema Definitions and Mixed-Type Fields

## Problem Statement

The plan's agent-native section defines `outputSchema` for `tsc_check` as an example but does not provide concrete schema definitions for `bun_testCoverage` or `biome_lintFix`. Additionally, two structural issues exist in the existing data shapes that would propagate into agent-facing contracts:

1. **`bun_testCoverage`** -- the `uncovered` field mixes file path and percentage into a single string (e.g., `"src/utils.ts: 42%"`). This is unparseable for agents without string manipulation.
2. **`biome_lintFix`** -- sums `formatFixed` and `lintFixed` into a single `fixed` number. Agents cannot distinguish between formatting fixes and lint fixes.

If `outputSchema` is added during Phase A without addressing these, the mixed-type fields become part of the agent-facing contract and are harder to change later.

## Findings

1. The plan states "Add `outputSchema` to all 7 tools" as a Phase A deliverable but only provides a concrete schema example for `tsc_check`.
2. `bun_testCoverage` returns a `TestSummary`-like shape with a coverage section. The `uncovered` array contains formatted strings rather than structured objects.
3. `biome_lintFix` returns a `LintSummary` variant with a `fixed` count that combines two distinct operations (format write + lint fix).
4. Without all 7 schemas defined in the plan, Phase A implementers must design them ad hoc, risking inconsistency.
5. The plan explicitly calls out `outputSchema` as "first-class migration deliverables, not stretch goals" -- yet leaves 2 of 7 schemas undefined.

## Proposed Solutions

### Solution 1: Add outputSchema definitions for all missing tools in the plan

Define Zod schemas for `bun_testCoverage` and `biome_lintFix` (and verify the other 4 tools have implicit or explicit definitions), keeping existing field shapes as-is.

```typescript
// bun_testCoverage (current shape)
outputSchema: z.object({
  totalFiles: z.number(),
  coveredFiles: z.number(),
  lineCoverage: z.number().describe('Overall line coverage percentage'),
  uncovered: z.array(z.string()).describe('Files with coverage below threshold'),
})

// biome_lintFix (current shape)
outputSchema: z.object({
  fixed: z.number().describe('Total fixes applied (format + lint)'),
  remaining: z.number().describe('Issues that could not be auto-fixed'),
})
```

- **Pros:** Unblocks Phase A immediately. Documents current behavior.
- **Cons:** Enshrines mixed-type fields into the agent contract. Harder to change later.
- **Effort:** Small (1-2 hours to define schemas)
- **Risk:** Medium. Technical debt in the contract layer.

### Solution 2: Separate mixed fields into structured objects

Restructure `uncovered` as an array of objects and split `fixed` into separate counts before defining outputSchema.

```typescript
// bun_testCoverage (restructured)
outputSchema: z.object({
  totalFiles: z.number(),
  coveredFiles: z.number(),
  lineCoverage: z.number().describe('Overall line coverage percentage'),
  uncovered: z.array(z.object({
    file: z.string().describe('File path'),
    percentage: z.number().describe('Line coverage percentage'),
  })).describe('Files with coverage below threshold'),
})

// biome_lintFix (restructured)
outputSchema: z.object({
  formatFixed: z.number().describe('Number of formatting issues fixed'),
  lintFixed: z.number().describe('Number of lint issues fixed'),
  remaining: z.number().describe('Issues that could not be auto-fixed'),
})
```

- **Pros:** Clean agent-facing contract from day one. No string parsing needed by consumers. Follows the plan's own principle of "lowest-cost moment to get agent-native design right."
- **Cons:** Requires changes to the parser/formatter code, not just schema definitions. Slightly more Phase A scope.
- **Effort:** Medium (4-6 hours -- schema definitions + parser changes + test updates)
- **Risk:** Low. Parser changes are straightforward; the data is already available in structured form before being concatenated.

### Solution 3: Define all schemas now, mark mixed fields for Phase B cleanup

Add schemas for all 7 tools using current field shapes but add explicit TODO comments and a Phase B backlog item to restructure mixed fields.

- **Pros:** Unblocks Phase A without scope creep. Mixed fields are documented as known debt.
- **Cons:** Two schema versions (current + future) create migration burden for early adopters. May never get cleaned up.
- **Effort:** Small (2-3 hours)
- **Risk:** Medium. "Defer to later phase" items have low completion rates.

## Technical Details

The 7 tools that need outputSchema:

| Runner | Tool | Schema Status |
|--------|------|--------------|
| tsc-runner | `tsc_check` | Defined in plan |
| bun-runner | `bun_runTests` | Implicit (TestSummary shape) |
| bun-runner | `bun_testFile` | Implicit (TestSummary shape) |
| bun-runner | `bun_testCoverage` | Missing -- has mixed `uncovered` field |
| biome-runner | `biome_lintCheck` | Implicit (LintSummary shape) |
| biome-runner | `biome_lintFix` | Missing -- has combined `fixed` count |
| biome-runner | `biome_formatCheck` | Implicit (format result shape) |

The SDK validates `structuredContent` against `outputSchema` at runtime and throws a hard error on mismatch (not graceful `isError`). Getting the schemas right before Phase A avoids runtime failures.

## Acceptance Criteria

- [ ] All 7 tools across 3 runners have outputSchema defined in the plan
- [ ] No mixed-type fields (string containing multiple data points, or single number combining distinct counts)
- [ ] Each outputSchema field has a `.describe()` annotation for agent discoverability
- [ ] Schema definitions match actual parser output shapes (verified against source)

## Work Log

| Date | Note |
|------|------|
| 2026-03-04 | Code review finding documented |

## Resources

- Plan section: "Agent-native design improvements" (lines 263-297)
- Plan section: "Add `outputSchema` to all 7 tools" (Phase A deliverable, line 412)
- `packages/bun-runner/mcp/index.ts` -- bun-runner source (TestSummary shape)
- `packages/biome-runner/mcp/index.ts` -- biome-runner source (LintSummary shape)
- [MCP SDK structuredContent validation (Issue #654)](https://github.com/modelcontextprotocol/typescript-sdk/issues/654)
