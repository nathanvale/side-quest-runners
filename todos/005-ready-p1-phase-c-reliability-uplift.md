---
status: ready
priority: p1
issue_id: "005"
tags: [mcp, tsc-runner, reliability, incremental, security, errors]
dependencies: ["004"]
---

# Phase C: tsc-runner Reliability Uplift

## Problem Statement

`tsc-runner` has reliability gaps: no incremental mode (slow warm runs), blanket env forwarding (security risk), no structured error categories, and the parser can silently return 0 errors on a failed run.

## Findings

- Issue #32: no `--incremental` flag -- missing 80-95% speedup on warm runs
- Issue #33: `env: { ...process.env, CI: 'true' }` forwards entire environment
- No structured error codes -- all failures return generic messages
- Parser can return `{ errors: [], errorCount: 0 }` when tsc exits non-zero but output doesn't match regex
- Since TS 5.6, `.tsbuildinfo` is always written -- `--incremental` just makes tsc read it
- Concurrency risk: two tsc processes can corrupt `.tsbuildinfo` (no file locking)

## Proposed Solutions

### Option 1: Implement all three reliability improvements

**Approach:**
1. Add `--incremental` flag to tsc invocation
2. Replace `...process.env` with strict allowlist: `PATH`, `HOME`, `NODE_PATH`, `BUN_INSTALL`, `TMPDIR`
3. Add structured error codes: `CONFIG_NOT_FOUND`, `TIMEOUT`, `SPAWN_FAILURE`, `PATH_NOT_FOUND`
4. Add parser fallback: if exit code non-zero but 0 errors parsed, include raw stderr + parse warning
5. Detect `.tsbuildinfo` corruption signatures and surface remediation hints

**Effort:** 3-4 hours

**Risk:** Low (each change is a discrete commit with clear rollback)

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts` -- spawn args, env, error handling, parser

**Env allowlist:**
```typescript
const TSC_ENV_ALLOWLIST = ['PATH', 'HOME', 'NODE_PATH', 'BUN_INSTALL', 'TMPDIR'] as const
```

**Structured error codes as `isError: true` responses:**
- `CONFIG_NOT_FOUND` -- no tsconfig.json found
- `TIMEOUT` -- tsc process exceeded timeout
- `SPAWN_FAILURE` -- tsc binary not found or failed to start
- `PATH_NOT_FOUND` -- requested path does not exist

## Resources

- GitHub Issues: #32, #33
- [tsc incremental + Bun subprocess research](/Users/nathanvale/code/side-quest-marketplace/docs/research/2026-03-03-tsc-incremental-bun-subprocess-patterns.md)

## Acceptance Criteria

- [ ] `--incremental` flag added to tsc invocation
- [ ] Env allowlist enforced -- no `...process.env`
- [ ] Structured error codes for all operationally distinct failures
- [ ] Parser never returns 0 errors on non-zero exit code
- [ ] `.tsbuildinfo` corruption detected and surfaced
- [ ] No silent parse failures in any test scenario
- [ ] Timeout/config/path errors correctly categorized
- [ ] Each change is a discrete, revertable commit

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase C
- Depends on Phase B (issue 004)
