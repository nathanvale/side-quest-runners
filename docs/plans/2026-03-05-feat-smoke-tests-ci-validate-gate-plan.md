---
title: "Add Smoke Tests to PR CI and Local Validate Gate"
type: feat
status: completed
date: 2026-03-05
---

# Add Smoke Tests to PR CI and Local Validate Gate

## Enhancement Summary

**Deepened on:** 2026-03-05  
**Sections enhanced:** 12  
**Research agents used:** `deepen-plan`, `best-practices-researcher` (plus local skill/learnings discovery and official docs validation)

### Key Improvements

1. Added authoritative GitHub Actions constraints around `GITHUB_STEP_SUMMARY` (step isolation, 1 MiB cap, upload timing).
2. Added concrete implementation guidance to ensure summary output still appears on partial failures.
3. Added CI/runtime reliability guardrails (timeouts, deterministic fixtures, flake handling, and measurable thresholds).

### New Considerations Discovered

- `GITHUB_STEP_SUMMARY` is step-scoped and uploaded when the step ends, so summary writing should occur in a `finally` path in the smoke script for partial-failure visibility.
- Job-summary upload failures do not fail the step/job, so smoke pass/fail must remain assertion/exit-code driven.
- Bun positional test filters are substring matches (not globs), which matters for future smoke test filtering assumptions.

## Section Manifest

Section 1: Overview/Problem Statement - strengthen rationale with CI gate design best practices.  
Section 2: Proposed Solution - refine step ordering and summary-write behavior.  
Section 3: Technical Considerations - add official constraints and operational limits.  
Section 4: System-Wide Impact - deepen failure propagation and state cleanup behavior.  
Section 5: SpecFlow Analysis - add missing edge cases from external docs.  
Section 6: Acceptance Criteria - make criteria measurable and failure-aware.  
Section 7: Success Metrics - add concrete threshold targets.  
Section 8: Dependencies & Risks - include updated platform-change risks and mitigations.  
Section 9: Implementation Notes - tighten pseudocode with summary-in-finally behavior.  
Section 10: AI-Era Notes - include review gates for AI-edited workflow logic.  
Section 11: Research Summary - include deprecation/sunset checks.  
Section 12: Sources & References - add primary-source documentation URLs.

## Overview

Add cross-runner smoke tests (`bun run test:smoke`) to the PR quality workflow and the local `validate` script so integration regressions are caught earlier. Also ensure smoke sandbox artifacts are gitignored, and publish per-runner smoke results to GitHub Step Summary for fast feedback.

### Research Insights

**Best Practices:**
- Keep smoke tests in the existing test job to avoid duplicate runner provisioning overhead and preserve fail-fast behavior.
- Keep smoke as a behavior/contract signal layered after lint/typecheck/unit tests.

**Performance Considerations:**
- Add smoke after unit tests to avoid spending CI minutes when fast checks already fail.
- Track smoke duration trend so this gate remains lightweight (target under 30s on hosted runners).

**Edge Cases:**
- Partial-run failure should still emit actionable summary rows.
- Cancellation behavior should not hide completed-runner outcomes.

## Problem Statement / Motivation

Current quality gates cover lint, typecheck, unit tests, and build, but they do not enforce end-to-end MCP stdio checks in CI or the default local validation chain.

This leaves a reliability gap:

- Unit tests can pass while real stdio tool wiring regresses.
- Developers may push code that passes `validate` but fails smoke behavior.
- Temporary smoke sandbox folders can become noisy untracked files when cleanup is skipped.

### Research Insights

**Best Practices:**
- Treat CI smoke tests as integration guardrails, not replacements for unit tests.
- Prefer deterministic fixtures and isolated temp sandboxes for reproducibility.

**Implementation Details:**
```yaml
# .github/workflows/pr-quality.yml (test job ordering)
- name: Run tests (all packages)
  run: bun run test:ci

- name: Run smoke tests (end-to-end MCP stdio)
  run: bun run test:smoke
```

## Proposed Solution

1. Add a smoke step to `.github/workflows/pr-quality.yml` inside the existing `test` job, after `test:ci`.
2. Extend `scripts/smoke/run-smoke.ts` to collect per-runner outcomes and write a markdown table to `$GITHUB_STEP_SUMMARY` when present.
3. Append `&& bun run test:smoke` to the root `validate` script in `package.json`.
4. Add `reports/smoke-sandboxes/` to `.gitignore` under test artifacts.

### Research Insights

**Best Practices:**
- Build job summaries from a single in-memory result array to avoid status drift.
- Keep job status tied to process exit code, not summary rendering success.

**Performance Considerations:**
- Avoid separate workflow jobs for smoke unless parallelism is required; separate jobs add setup/install overhead.

**Edge Cases:**
- If one runner fails, include failed row plus prior successful rows.
- If cleanup fails, surface cleanup error without swallowing original failure context.

## Research Summary

### Local Repo Findings

- Smoke harness exists and already validates all three runners: [scripts/smoke/run-smoke.ts](../../scripts/smoke/run-smoke.ts).
- CI PR workflow currently runs unit tests only in the `test` job: [.github/workflows/pr-quality.yml](../../.github/workflows/pr-quality.yml).
- Local validate chain currently excludes smoke tests: [package.json](../../package.json).
- Smoke docs already define sandbox behavior under `reports/smoke-sandboxes/`: [docs/testing/smoke-tests.md](../testing/smoke-tests.md).
- `.gitignore` has test artifact sections but does not include `reports/smoke-sandboxes/`: [.gitignore](../../.gitignore).

### Institutional Learnings

- Relevant solution found: [docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md](../solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md).
- Key transferable pattern: behavioral/contract changes should be validated with runtime evidence, not static proxies. Applying this here supports making smoke tests first-class in CI/local gates.

### External Research (Added)

- GitHub Actions workflow commands and summary behavior validated in official docs.
- GitHub Actions expression behavior (`always()`, `!cancelled()`) validated in official docs.
- Bun test filtering behavior validated in official Bun docs.
- Node `appendFile` semantics (file creation behavior) validated in Node docs.

### Deprecation/Sunset Check (2026-03-05)

- **GitHub Actions:** No deprecation found for `GITHUB_STEP_SUMMARY`; related platform changes are around runner/image/cache/check-run behaviors, not job summaries.
- **Bun test CLI:** No deprecation found for positional filter behavior used by this plan.

## Technical Considerations

- **Execution order:** Smoke should run after unit tests in the same `test` job to avoid unnecessary runtime when fast checks already fail.
- **Signal quality:** Per-runner pass/fail + elapsed time should be emitted by the smoke harness itself for accurate status reporting.
- **Failure semantics:** Any smoke runner failure should fail the `test` job.
- **Developer DX:** Adding smoke to `validate` increases runtime but catches integration failures before push.
- **Artifact hygiene:** `SMOKE_KEEP_SANDBOXES=1` is useful for debugging and must remain safe with `.gitignore` coverage.

### Research Insights

**Best Practices:**
- `GITHUB_STEP_SUMMARY` is per-step, appended as Markdown, then uploaded at step completion.
- Step summaries are isolated and capped at 1 MiB per step.
- Upload failure for summary content does not fail the step/job.

**Implementation Details:**
```ts
// scripts/smoke/run-smoke.ts
// Write summary in a finally path so partial results survive failures.
try {
  // run each runner and push result rows
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) {
    // append markdown from collected results array
  }
}
```

**Edge Cases:**
- Summary should be best-effort only; never replace exit-code based failure signaling.
- Protect against oversized summary payloads by keeping table compact.

## System-Wide Impact

- **Interaction graph:**
  - PR workflow `test` job -> `bun run test:ci` -> `bun run test:smoke` -> `scripts/smoke/run-smoke.ts` -> spawns three MCP runners over stdio -> reports to console and `$GITHUB_STEP_SUMMARY`.
- **Error propagation:**
  - Runner assertion failures bubble to smoke script failure -> non-zero exit -> GitHub `test` job fails -> gate job blocked.
- **State lifecycle risks:**
  - Interrupted runs may leave sandbox folders; `.gitignore` prevents accidental VCS noise.
- **API surface parity:**
  - No public MCP tool API change; only CI/local gate behavior and smoke reporting output change.
- **Integration test scenarios:**
  - CI run where all runners pass and summary table shows three pass rows.
  - CI run with one intentionally failing runner shows failed row and failed job.
  - Local `validate` catches smoke regression after unit tests pass.

### Research Insights

**Best Practices:**
- Keep runner result shape stable (`name`, `status`, `elapsedMs`, optional `error`) so summary, logs, and future metrics are derived consistently.
- Preserve deterministic fixture inputs across runners to reduce CI variability.

**Performance Considerations:**
- Collect per-runner elapsed metrics to spot regressions over time.

**Edge Cases:**
- Handle canceled jobs: if using a separate summary step later, prefer `if: ${{ !cancelled() }}` where appropriate per GitHub guidance.

## SpecFlow Analysis (Applied)

### Gaps Identified

- Per-runner CI summary output is currently absent despite runner-level timing data existing in-process.
- Current workflow summary is gate-level only, so smoke diagnostics are not visible in the same UX pattern.

### Edge Cases Added

- `GITHUB_STEP_SUMMARY` unset locally: smoke script should skip summary-write path without failing.
- Partial runner pass/fail: summary must still include all attempted runners with status and elapsed time.
- Sandbox cleanup failures should not mask primary smoke failure signal.
- Summary-write failure should be logged as warning while preserving primary test status signal.

### Acceptance Criteria Adjustments

- Added explicit criterion for summary emission behavior in both CI and local contexts.
- Added explicit criterion for per-runner status visibility.
- Added criterion to verify summary content remains below practical size limits.

## Acceptance Criteria

- [x] `.github/workflows/pr-quality.yml` runs `bun run test:smoke` in the existing `test` job after `bun run test:ci`.
- [x] `scripts/smoke/run-smoke.ts` writes a per-runner markdown table to `$GITHUB_STEP_SUMMARY` when the variable is set.
- [x] Smoke summary includes runner name, pass/fail status, elapsed time, and an optional compact error note on failure.
- [x] Summary-writing path executes on both pass and fail outcomes for attempted runners.
- [x] Root `package.json` `validate` script includes `&& bun run test:smoke` after existing test execution.
- [x] `.gitignore` includes `reports/smoke-sandboxes/`.
- [x] `bun run test:smoke` still passes locally.
- [x] `bun run validate` passes locally with smoke included.
- [x] Smoke summary content remains compact and under GitHub step summary limits.

## Success Metrics

- PRs with integration regressions fail in `test` job before merge.
- GitHub step summaries show runner-level smoke status without opening raw logs.
- Local pre-push validation catches smoke failures that unit tests miss.
- No recurring untracked sandbox artifact noise from smoke runs.
- Median smoke runtime remains stable (target: <= 30s on hosted CI; investigate regressions over +20%).

## Dependencies & Risks

### Dependencies

- Existing smoke harness and fixture behavior in `scripts/smoke/run-smoke.ts`.
- Existing PR workflow topology in `.github/workflows/pr-quality.yml`.

### Risks

- **CI duration increase:** smoke adds runtime to the `test` job.
- **Flake risk:** subprocess-based smoke tests could be sensitive to CI environment variance.
- **Summary drift:** if runner case names change, summary formatting may become stale.
- **Platform churn risk:** future GitHub Actions platform changes (runner images, cache ecosystem, action behaviors) could impact CI indirectly.

### Mitigations

- Keep smoke in current test job (no extra runner bootstrap overhead).
- Preserve deterministic smoke fixtures and avoid external dependencies.
- Generate summary rows directly from runtime results array (single source of truth).
- Keep smoke assertions isolated from summary upload semantics.

## Implementation Notes

### Target Files

1. `.github/workflows/pr-quality.yml`
2. `scripts/smoke/run-smoke.ts`
3. `package.json`
4. `.gitignore`

### Pseudocode Sketch

```ts
// scripts/smoke/run-smoke.ts
import { appendFile } from 'node:fs/promises'

interface RunnerResult {
  name: string
  passed: boolean
  elapsedMs: number
  error?: string
}

const results: RunnerResult[] = []
let runError: unknown

try {
  for (const runnerCase of runnerCases) {
    const started = Date.now()
    try {
      await runnerCase.run(sandboxRoot)
      results.push({
        name: runnerCase.name,
        passed: true,
        elapsedMs: Date.now() - started,
      })
    } catch (error) {
      results.push({
        name: runnerCase.name,
        passed: false,
        elapsedMs: Date.now() - started,
        error: String(error),
      })
      runError = error
      throw error
    }
  }
} finally {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const rows = results.map((r) =>
      `| ${r.name} | ${r.passed ? 'pass' : 'FAIL'} | ${r.elapsedMs}ms |`,
    )
    await appendFile(
      summaryPath,
      ['## Smoke Tests (MCP stdio)', '', '| Runner | Status | Time |', '|---|---|---|', ...rows, ''].join('\n'),
    )
  }
}
```

### Research Insights

**Best Practices:**
- Keep summary generation close to runtime data capture.
- Avoid separate hand-maintained workflow summary rows for each runner.

**Edge Cases:**
- `appendFile` creates the file if absent; still handle IO exceptions explicitly.
- Keep summary concise to avoid line-noise and size limit issues.

## AI-Era Notes

- This plan is optimized for fast AI-assisted implementation by keeping file scope tightly bounded (4 files) and acceptance criteria testable via two existing commands.
- Any AI-generated workflow YAML edits should be reviewed for job-order and `needs` regressions.
- Any AI-generated summary formatting should be checked against real GitHub run rendering.

## Sources & References

- Feature description input: `~/.claude/plans/valiant-strolling-turtle.md`
- Related brainstorm context (cross-runner gate motivation): [docs/brainstorms/2026-03-04-tsc-runner-uplift.md](../brainstorms/2026-03-04-tsc-runner-uplift.md)
- Smoke harness implementation: [scripts/smoke/run-smoke.ts](../../scripts/smoke/run-smoke.ts)
- PR quality workflow: [.github/workflows/pr-quality.yml](../../.github/workflows/pr-quality.yml)
- Local validation script: [package.json](../../package.json)
- Smoke test docs: [docs/testing/smoke-tests.md](../testing/smoke-tests.md)
- Institutional learning: [docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md](../solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md)
- GitHub Actions workflow commands (`GITHUB_STEP_SUMMARY`, limits, upload semantics): https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
- GitHub Actions expressions (`always()`, `!cancelled()`): https://docs.github.com/en/actions/reference/workflows-and-actions/expressions
- GitHub Actions deprecations/changelog notice (2025-02-12): https://github.blog/changelog/2025-02-12-notice-of-upcoming-deprecations-and-breaking-changes-for-github-actions/
- Bun test behavior and filter semantics: https://bun.sh/docs/test
- Node fs append behavior: https://nodejs.org/download/release/v22.10.0/docs/api/fs.html
