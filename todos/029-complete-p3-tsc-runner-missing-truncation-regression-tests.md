---
status: complete
priority: p3
issue_id: "029"
tags: [code-review, testing, tsc-runner, reliability]
dependencies: []
---

# TSC Runner Lacks Truncation Regression Coverage

## Problem Statement

`tsc-runner` now includes bounded stream capture and truncation failure behavior, but there is no direct regression test proving truncation paths (`stdoutTruncated` / `stderrTruncated`) produce the expected `SPAWN_FAILURE`.
This leaves a reliability-critical change under-tested compared with biome-runner and bun-runner.

## Findings

- `packages/tsc-runner/mcp/index.ts:525-570` enforces output caps and throws on truncation.
- `packages/biome-runner/mcp/index.test.ts:241-250` and `packages/bun-runner/mcp/index.test.ts:422-430` include explicit truncation tests.
- `packages/tsc-runner/mcp/index.test.ts` has no equivalent truncation-focused test coverage.

## Proposed Solutions

### Option 1: Add Unit-Level Spawn Truncation Tests (Recommended)

**Approach:** Export or dependency-inject the spawn helper (or stream collector) and add deterministic truncation tests similar to other runners.

**Pros:**
- Symmetric coverage across all runners.
- Fast and deterministic test path.

**Cons:**
- May require small refactor for test seam.

**Effort:** Small

**Risk:** Low

---

### Option 2: Add Integration Test For Oversized Compiler Output

**Approach:** Invoke `tsc_check` against synthetic noisy output conditions and assert tool failure envelope.

**Pros:**
- Tests full tool surface.

**Cons:**
- More brittle and potentially slower.
- Harder to make deterministic across environments.

**Effort:** Medium

**Risk:** Medium

## Recommended Action

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.test.ts`
- Optional: `packages/tsc-runner/mcp/index.ts` (if a test seam is needed)

## Resources

- PR context: `https://github.com/nathanvale/side-quest-runners/pull/43`

## Acceptance Criteria

- [ ] At least one regression test validates truncation handling for tsc-runner.
- [ ] Test asserts returned failure is `SPAWN_FAILURE` with truncation remediation guidance.
- [ ] Test suite remains green.

## Work Log

### 2026-03-07 - Review Finding Capture

**By:** Codex

**Actions:**
- Compared runner truncation test coverage across biome, bun, and tsc packages.
- Confirmed absence of explicit truncation regression assertions in tsc-runner tests.

**Learnings:**
- Reliability guardrails were implemented consistently in code, but test parity lagged in one runner.

## Notes

- This is a test-coverage risk, not confirmed production breakage.
