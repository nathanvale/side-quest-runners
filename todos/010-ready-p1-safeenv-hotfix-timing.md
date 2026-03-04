---
status: ready
priority: p1
issue_id: "010"
tags: [code-review, security, environment]
dependencies: []
---

# safeEnv() Hotfix Timing -- Full process.env Leak to Child Processes

## Problem Statement

All three runners leak the full `process.env` to child processes via `spawnAndCollect`'s `...process.env` merge. Any environment variable set in the parent process -- API keys, tokens, secrets, credentials -- is forwarded to spawned subprocesses (tsc, bun test, biome). This is a data leak that exists today in production.

The Phase 0 plan correctly identifies this issue but defers `safeEnv()` to Phase A. The code review finding is that this should be treated as a hotfix before Phase A begins, since:

1. The leak is active now, not a theoretical future risk
2. The fix is small and self-contained (does not require the full SDK migration)
3. Phase A timeline is uncertain -- it depends on Phase 0 completion, which hasn't started yet
4. Any env var set by Claude Code, IDE extensions, or shell profiles is forwarded to every subprocess

**Specific leak paths:**
- tsc-runner: passes `{ ...process.env, CI: 'true' }` directly
- bun-runner: passes `{ CI: 'true' }` but core's `spawnAndCollect` merges `...process.env` underneath
- biome-runner: same as bun-runner via `spawnAndCollect`

## Findings

1. **Core's `spawnAndCollect`** always spreads `...process.env` even when the caller provides a partial env object -- the caller's intent to limit env is silently overridden
2. **bun-runner's false sense of security:** It passes `{ CI: 'true' }` thinking it's providing a minimal environment, but core spreads the full parent env underneath
3. **Claude Code context:** MCP servers run as child processes of Claude Code, which may have `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and other sensitive variables in its environment
4. **IDE context:** VS Code and other editors often inject extension-specific tokens and API keys into the shell environment
5. **No documentation of the leak:** Neither core's JSDoc nor the runner code documents that full env is forwarded
6. **Phase A dependency chain:** Phase 0 (not started) -> Phase A (where safeEnv is currently scoped) -- could be weeks before Phase A begins

## Proposed Solutions

### Option 1: Hotfix -- implement safeEnv() allowlist immediately as standalone PR

**Approach:** Create a `safeEnv()` function that returns only explicitly-allowed environment variables. Ship it as a standalone PR to core (or as a local utility if core changes are too slow) before Phase A begins.

**Allowlist per runner:**
- tsc-runner: `PATH`, `HOME`, `CI`, `NODE_OPTIONS`, `TSC_NONPOLLING_WATCHER`
- bun-runner: `PATH`, `HOME`, `CI`, `NODE_OPTIONS`, `BUN_*` (bun-specific vars)
- biome-runner: `PATH`, `HOME`, `CI`

**Pros:**
- Closes the leak immediately
- Small, reviewable change (one function + 3 call site updates)
- No dependency on SDK migration or Phase A timeline
- Can be done as a core PR or as a local wrapper in each runner

**Cons:**
- If done in core, requires a core release (cross-repo friction the plan is trying to eliminate)
- If done locally, creates temporary duplication that Phase A cleans up
- Risk of breaking runners if a required env var is missing from allowlist

**Effort:** Low (2-4 hours including testing)

**Risk:** Medium -- must test thoroughly to ensure no runner breaks from missing env vars. Bun and tsc may need env vars we haven't identified. Mitigation: start with a generous allowlist and tighten over time.

---

### Option 2: Keep in Phase A but document risk explicitly

**Approach:** Add a "Known Accepted Risks" section to the Phase 0 plan and runner READMEs explicitly documenting the env leak. Add a comment in each runner's spawn call site documenting the leak. Keep the fix in Phase A scope.

**Pros:**
- No code changes, no risk of breaking anything
- Explicit documentation creates accountability and visibility
- Follows the plan's existing timeline

**Cons:**
- Leak remains active for an indeterminate period
- "Accepted risk" can become "forgotten risk" if Phase A is delayed
- Documentation doesn't actually protect against the leak

**Effort:** Very low (1 hour)

**Risk:** Low for implementation, but high for continued exposure

---

### Option 3: Intermediate -- strip known-dangerous env vars

**Approach:** Instead of an allowlist (which might miss required vars), use a denylist to strip known-dangerous patterns: `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, `ANTHROPIC_*`, `OPENAI_*`, `GITHUB_TOKEN`.

**Pros:**
- Lower risk of breaking runners (only removes clearly sensitive vars)
- Faster to implement than a full allowlist (no need to audit each runner's env requirements)
- Can ship as a quick PR

**Cons:**
- Denylist is inherently incomplete -- new sensitive vars won't be caught
- False sense of security (blocks known patterns, misses unknown ones)
- Still leaks non-secret but private env vars (user paths, editor config, etc.)
- Eventually needs replacement with a proper allowlist anyway

**Effort:** Low (1-2 hours)

**Risk:** Low for implementation, medium for completeness

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts` -- direct `process.env` spread
- `packages/bun-runner/mcp/index.ts` -- passes partial env to core's spawn
- `packages/biome-runner/mcp/index.ts` -- passes partial env to core's spawn
- Core's `spawn/index.ts` -- `spawnAndCollect` merges `...process.env`

**Current code (tsc-runner):**
```typescript
const result = await spawnWithTimeout({
  cmd: ['tsc', '--noEmit', '--pretty', 'false', '-p', configPath],
  env: { ...process.env, CI: 'true' },
  // ...
})
```

**Current code (core's spawnAndCollect, approximate):**
```typescript
export async function spawnAndCollect(options) {
  const proc = Bun.spawn(options.cmd, {
    env: { ...process.env, ...options.env },
    // ...
  })
}
```

**Proposed safeEnv() (Option 1):**
```typescript
const ENV_ALLOWLIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'CI',
  'NODE_OPTIONS',
  'TERM',
  'TMPDIR',
])

export function safeEnv(
  extra: Record<string, string> = {},
  additionalAllowed: string[] = []
): Record<string, string> {
  const allowed = new Set([...ENV_ALLOWLIST, ...additionalAllowed])
  const env: Record<string, string> = {}
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]!
    }
  }
  return { ...env, ...extra }
}
```

**Example leakable variables in a typical Claude Code environment:**
- `ANTHROPIC_API_KEY` -- Claude API key
- `GITHUB_TOKEN` -- GitHub personal access token
- `NPM_TOKEN` -- npm publish token
- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` -- AWS credentials
- `OPENAI_API_KEY` -- OpenAI API key
- Various `*_SECRET`, `*_PASSWORD` variables from other tools

## Acceptance Criteria

- [ ] `safeEnv()` implemented with explicit allowlist of required environment variables
- [ ] No runner forwards full `process.env` to child processes
- [ ] Allowlist documented per runner (what each runner needs and why)
- [ ] Tests verify that sensitive-looking env vars (e.g., `API_KEY=secret`) are NOT forwarded
- [ ] Tests verify that required env vars (e.g., `PATH`, `HOME`) ARE forwarded
- [ ] Existing runner functionality confirmed unbroken (tsc, bun test, biome all still work)

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created from code review of Phase 0 architecture gate plan
- Escalated timing from Phase A to hotfix based on active leak assessment

**Learnings:**
- `spawnAndCollect` silently overrides caller's intent to limit env by spreading `process.env` underneath
- bun-runner's `{ CI: 'true' }` creates a false sense of minimal env forwarding
- Security fixes with small blast radius should not wait for large migration milestones

## Resources

- [Phase 0 plan, security section](docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md) -- identifies the leak, defers to Phase A
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) -- principle of least privilege for subprocess environments
- `packages/tsc-runner/mcp/index.ts` -- direct env spread
- `packages/bun-runner/mcp/index.ts` -- partial env passed to core
- `packages/biome-runner/mcp/index.ts` -- partial env passed to core
- Core's `spawn/index.ts` -- `spawnAndCollect` implementation
