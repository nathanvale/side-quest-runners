---
status: complete
priority: p1
issue_id: "012"
tags: [code-review, performance, biome-runner]
dependencies: []
---

# biome_lintFix runs 3 sequential subprocesses -- collapse to 1-2

## Problem Statement

`runBiomeFix` spawns 3 sequential subprocesses: `biome format --write`, `biome check --write`, then `biome check` (read-only for remaining diagnostics). Each `bunx` invocation has cold-start overhead. Worst case is 90s before the caller gets a response. This is the highest-latency tool in the fleet and directly impacts Claude Code's edit-lint-fix loop.

`biome check --write` already applies both formatting and lint fixes -- the separate `biome format --write` step is likely redundant.

## Findings

1. **Performance oracle:** 3 sequential `bunx` invocations, each with 30s timeout. For large codebases, 15-45s total per call.
2. **Simplicity reviewer:** Confirmed the redundancy -- `biome check --write` runs the formatter as part of its pipeline.
3. **Architecture strategist:** No architectural objection to collapsing; the separation was inherited from core's `spawnAndCollect` pattern.

## Proposed Solutions

### Option A: Collapse format+check into single `biome check --write` (Recommended)

- Drop the `biome format --write` call entirely
- Keep `biome check --write` (handles both lint and format fixes)
- Keep the final read-only `biome check` to report remaining issues
- **Pros:** 33% latency reduction, simpler code, fewer failure points
- **Cons:** May lose granular `formatFixed` vs `lintFixed` counts (verify biome's JSON output)
- **Effort:** Small
- **Risk:** Low

### Option B: Parse step 2 output for remaining diagnostics, drop step 3

- Collapse to single `biome check --write` and parse its output for both fixed counts and remaining issues
- **Pros:** 66% latency reduction (1 subprocess instead of 3)
- **Cons:** Need to verify biome reports remaining issues in `--write` mode output
- **Effort:** Medium
- **Risk:** Medium -- depends on biome's JSON reporter behavior in write mode

## Technical Details

**Affected files:**
- `packages/biome-runner/mcp/index.ts` lines 283-339 (`runBiomeFix`)

## Acceptance Criteria

- [ ] `biome_lintFix` uses at most 2 subprocess invocations (ideally 1)
- [ ] Fixed counts (format vs lint) still reported accurately or documented as combined
- [ ] Integration test for `biome_lintFix` structuredContent still passes
- [ ] Latency measurably reduced (before/after timing)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Performance oracle + simplicity reviewer flagged |

## Resources

- Performance oracle review finding CRITICAL-2
- Simplicity reviewer analysis
