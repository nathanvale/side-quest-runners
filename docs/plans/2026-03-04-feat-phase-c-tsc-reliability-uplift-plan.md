---
title: "Phase C: tsc-runner Reliability Uplift"
type: feat
status: active
date: 2026-03-04
priority: p1
origin: docs/brainstorms/2026-03-04-tsc-runner-uplift.md
depends_on: [phase-b]
absorbs: [005]
---

# Phase C: tsc-runner Reliability Uplift

## Overview

Add `--incremental` mode, strict env allowlist, structured error codes, and parser fallback to `tsc-runner`. These are the reliability primitives that prevent silent failures and security leaks.

## Problem Statement

`tsc-runner` has four reliability gaps:

1. **No `--incremental`** -- missing 80-95% speedup on warm runs (GitHub #32)
2. **Blanket env forwarding** -- `env: { ...process.env, CI: 'true' }` leaks API keys, tokens, secrets to child processes (GitHub #33)
3. **No structured error codes** -- all failures return generic messages, agents can't distinguish config-not-found from timeout
4. **Silent parser failures** -- parser can return `{ errors: [], errorCount: 0 }` when tsc exits non-zero but output doesn't match regex

**Note on env allowlist:** If security hotfix todo 010 (safeEnv) ships before this phase, the env allowlist here becomes a refinement of that work rather than greenfield. The acceptance criteria apply regardless.

## Proposed Solution

### 1. Incremental Mode

Add `--incremental` to tsc invocation. Since TS 5.6, `.tsbuildinfo` is always written -- `--incremental` just makes tsc read it.

**Concurrency risk:** Two tsc processes can corrupt `.tsbuildinfo` (no file locking). Detect corruption signatures and surface remediation hints.

### 2. Env Allowlist

```typescript
const TSC_ENV_ALLOWLIST = ['PATH', 'HOME', 'NODE_PATH', 'BUN_INSTALL', 'TMPDIR'] as const
```

Replace `{ ...process.env, CI: 'true' }` with filtered env that only includes allowlisted keys plus `CI: 'true'`.

### 3. Structured Error Codes

Return `isError: true` with error codes for operationally distinct failures:

| Code | Trigger |
|---|---|
| `CONFIG_NOT_FOUND` | No tsconfig.json/jsconfig.json found |
| `TIMEOUT` | tsc process exceeded timeout |
| `SPAWN_FAILURE` | tsc binary not found or failed to start |
| `PATH_NOT_FOUND` | Requested path does not exist |

### 4. Parser Fallback

If exit code is non-zero but 0 errors parsed, include raw stderr in the response with a parse warning. Never return silent success on failure.

### 5. `.tsbuildinfo` Corruption Detection

Detect common corruption signatures (truncated JSON, missing version field) and return actionable remediation: "Delete .tsbuildinfo and retry."

## Acceptance Criteria

- [ ] `--incremental` flag added to tsc invocation
- [ ] Env allowlist enforced -- no `...process.env`
- [ ] Structured error codes for CONFIG_NOT_FOUND, TIMEOUT, SPAWN_FAILURE, PATH_NOT_FOUND
- [ ] Parser never returns 0 errors on non-zero exit code
- [ ] `.tsbuildinfo` corruption detected and surfaced with remediation hint
- [ ] No silent parse failures in any test scenario
- [ ] Timeout/config/path errors correctly categorized
- [ ] Each change is a discrete, revertible commit

## Sources

- **Origin brainstorm:** [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md) -- Phase C definition
- **Research:** docs/research/2026-03-03-tsc-incremental-bun-subprocess-patterns.md (side-quest-marketplace repo)
- GitHub Issues: #32, #33
