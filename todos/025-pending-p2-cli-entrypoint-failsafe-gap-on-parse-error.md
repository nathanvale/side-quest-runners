---
status: pending
priority: p2
issue_id: "025"
tags: [code-review, hooks, reliability, stdout-contract]
dependencies: []
---

# CLI Entrypoint Failsafe Gap on Subcommand Parse Error

## Problem Statement

The hook CLI parses subcommands before entering the `try/catch` failsafe boundary. If argument parsing fails, the process exits with code `1` and emits no JSON envelope to stdout.

## Findings

- In [index.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/index.ts:56), `parseCommand(argv)` is called before `try`.
- Parsing throws on unknown/missing commands in [index.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/index.ts:83).
- Reproduction:
  - `bun packages/claude-hooks/hooks/index.ts bad-subcommand`
  - observed `exit=1`, `stdout_bytes=0`, error stack on stderr.
- This bypasses the intended top-level stdout safety boundary contract.

## Proposed Solutions

### Option 1: Move parse + handler creation inside `try`

**Approach:** Wrap command parsing in the same `try/catch` and emit `writeFailsafeJson('PostToolUse')` (or inferred event) on parse failures.

**Pros:**
- Enforces contract on all runtime paths
- Minimal refactor

**Cons:**
- Need deterministic event fallback when command is invalid

**Effort:** 1 hour

**Risk:** Low

---

### Option 2: Add outer guard around `runCli` invocation

**Approach:** Keep `runCli` mostly unchanged but wrap `await runCli(process.argv)` with top-level `try/catch` near `import.meta.main`.

**Pros:**
- Contains boundary at absolute top-level

**Cons:**
- Slight duplication with internal catch

**Effort:** 1 hour

**Risk:** Low

## Recommended Action


## Technical Details

**Affected files:**
- [index.ts](/Users/nathanvale/code/side-quest-runners/packages/claude-hooks/hooks/index.ts)

## Resources

- Plan: [2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md](/Users/nathanvale/code/side-quest-runners/docs/plans/2026-03-07-feat-hook-dedup-spec-and-claude-hooks-layout-plan.md)

## Acceptance Criteria

- [ ] Invalid subcommand path still emits valid JSON on stdout
- [ ] Invalid subcommand does not print non-JSON content to stdout
- [ ] Valid subcommands continue to behave unchanged

## Work Log

### 2026-03-07 - Review Finding Created

**By:** Codex

**Actions:**
- Reproduced bad-subcommand behavior and captured exit/stdout/stderr
- Traced control flow in CLI entrypoint
- Documented two low-risk fixes

**Learnings:**
- Safety boundaries should include argument parsing, not only handler execution

## Notes

