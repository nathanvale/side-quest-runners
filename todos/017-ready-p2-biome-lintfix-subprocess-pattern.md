---
status: ready
priority: p2
issue_id: "017"
tags: [code-review, performance, biome-runner]
dependencies: []
---

# biome_lintFix Sequential Subprocess Pattern Not Flagged

## Problem Statement

`biome_lintFix` runs 3 sequential subprocesses to accomplish a single fix operation:

1. **Format write** -- `biome format --write` to fix formatting issues
2. **Lint fix** -- `biome check --fix` (or `biome lint --fix`) to fix lint issues
3. **Re-check** -- `biome check` to verify the fixes were applied correctly

This means `biome_lintFix` takes approximately 3x longer than a single biome invocation. The plan does not flag this pattern anywhere -- not in the performance section, the biome-runner analysis, or the fix-while-migrating items.

The re-check (subprocess 3) may be redundant if biome's exit codes are reliable indicators of fix success. Biome returns exit code 0 when all fixable issues are resolved, which could eliminate the need for a verification pass.

## Findings

1. `biome_lintFix` in `packages/biome-runner/mcp/index.ts` runs 3 sequential `spawnAndCollect` calls.
2. Each subprocess invocation includes process spawn overhead + biome startup + file I/O.
3. The plan's performance section (lines 339-345) only discusses `getGitRoot()` caching and `JSON.stringify` formatting -- no mention of subprocess count.
4. Biome CLI supports `biome check --fix --formatter-enabled=true` which combines format and lint fix in a single invocation (since Biome 1.5+).
5. The re-check subprocess exists because the original implementation didn't trust biome's exit codes. This assumption should be validated against current biome versions.
6. `biome_lintCheck` and `biome_formatCheck` each run only 1 subprocess -- `biome_lintFix` is the outlier.

## Proposed Solutions

### Solution 1: Combine into single biome invocation

Use `biome check --fix --formatter-enabled=true` to combine format + lint fix into one subprocess. Remove the re-check if biome's exit code is reliable.

```typescript
// Before: 3 subprocesses
await spawnAndCollect('biome', ['format', '--write', path])
await spawnAndCollect('biome', ['check', '--fix', path])
const result = await spawnAndCollect('biome', ['check', path])

// After: 1 subprocess
const result = await spawnAndCollect('biome', [
  'check', '--fix', '--formatter-enabled=true', '--write', path
])
```

- **Pros:** 3x performance improvement. Simpler code. Single point of failure instead of three.
- **Cons:** Requires verifying biome CLI flag compatibility. Behavior may differ slightly from sequential application (format-then-lint vs combined). Need to confirm biome version supports `--formatter-enabled` flag.
- **Effort:** Small-medium (2-3 hours -- flag research + implementation + testing)
- **Risk:** Medium. Combined invocation may produce different results than sequential application in edge cases. Needs thorough testing.

### Solution 2: Remove the re-check subprocess

Keep format and lint as separate subprocesses but remove the verification re-check (subprocess 3). Rely on biome's exit code to determine success.

```typescript
// Before: 3 subprocesses
await spawnAndCollect('biome', ['format', '--write', path])
await spawnAndCollect('biome', ['check', '--fix', path])
const result = await spawnAndCollect('biome', ['check', path])  // re-check -- remove this

// After: 2 subprocesses
const formatResult = await spawnAndCollect('biome', ['format', '--write', path])
const lintResult = await spawnAndCollect('biome', ['check', '--fix', path])
// Use lintResult exit code and output directly
```

- **Pros:** ~33% performance improvement (2 subprocesses instead of 3). Lower risk than combining into one. Preserves current format-then-lint ordering.
- **Cons:** Still 2 subprocesses. Loses the "verify fixes applied" safety net. If biome's exit codes are unreliable, agents may see stale data.
- **Effort:** Small (1-2 hours)
- **Risk:** Low-medium. Biome exit codes have been reliable since 1.0 for the fix commands.

### Solution 3: Document the pattern and defer optimization to Phase D

Add the subprocess pattern to the plan's performance section. Create a Phase D (observability) optimization item with timing data to justify the change later.

- **Pros:** No risk of behavioral regression. Phase D observability will provide real timing data to quantify the improvement. Keeps Phase A scope focused on migration.
- **Cons:** 3x overhead persists through Phases A-C. Every `biome_lintFix` call pays the tax until Phase D.
- **Effort:** Trivial (plan text changes only)
- **Risk:** Low. Deferred optimization with documented justification.

## Technical Details

Subprocess timing breakdown for `biome_lintFix` on a typical project:

| Subprocess | Purpose | Estimated Time |
|-----------|---------|---------------|
| `biome format --write` | Fix formatting | ~200-500ms |
| `biome check --fix` | Fix lint issues | ~200-500ms |
| `biome check` (re-check) | Verify fixes | ~200-500ms |
| **Total** | | **~600-1500ms** |

With single combined invocation: ~200-500ms (3x improvement).

The re-check subprocess parses its output to build the final `LintSummary` response. If removed, the fix subprocess output must provide equivalent data (fix counts, remaining issues).

Biome CLI `check --fix` output includes:
- Number of files modified
- Number of fixes applied
- Any remaining unfixable issues (in stdout)
- Exit code: 0 = all fixed, non-zero = some issues remain

This output is sufficient to build a `LintSummary` without a re-check pass.

## Acceptance Criteria

- [ ] `biome_lintFix` subprocess count documented in the plan's performance section
- [ ] Optimization path identified and assigned to a specific phase
- [ ] If optimizing in Phase A: biome CLI flag compatibility verified for combined invocation
- [ ] If deferring: timing data requirement added to Phase D observability scope
- [ ] Re-check subprocess necessity evaluated against biome exit code reliability

## Work Log

| Date | Note |
|------|------|
| 2026-03-04 | Code review finding documented |

## Resources

- `packages/biome-runner/mcp/index.ts` -- biome_lintFix handler source
- [Biome CLI check command docs](https://biomejs.dev/reference/cli/#biome-check)
- [Biome CLI exit codes](https://biomejs.dev/reference/cli/#exit-codes)
- Plan section: "Performance considerations" (lines 339-345)
- Phase D scope: `006-ready-p2-phase-d-observability-uplift.md`
