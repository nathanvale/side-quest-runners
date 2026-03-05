---
title: "Minimal AB Mode for Discoverability Trend Detection"
type: feat
status: completed
date: 2026-03-05
priority: p2
deepened: 2026-03-06
sections_enhanced: 10
agents_used: 11
---

# Minimal AB Mode for Discoverability Trend Detection

## Enhancement Summary

**Deepened on:** 2026-03-06
**Sections enhanced:** 10
**Research agents used:** 11 (3 research, 7 review, 1 learnings)

### Key Improvements

1. **Simplified phasing** -- Collapsed 4 phases to 2 phases based on simplicity review. Phase 1 ships end-to-end minimal mode; Phase 2 adds on-demand trigger.
2. **Hardcoded thresholds over config file** -- Pattern consistency review confirmed no precedent for custom config files in this repo. Use inline constants with CLI arg overrides via existing `parseArg` pattern.
3. **Binary pass/fail over green/yellow/red** -- Simplicity review found yellow has no defined action. Start with binary alerting; add tiers later if needed.
4. **Sigma-based threshold calibration** -- Research found 2-sigma (warning) and 3-sigma (alert) from rolling baseline is industry standard. Start in observation mode for first 10 runs.
5. **GitHub Issue alerting with deduplication** -- Spec flow analysis identified missing notification channel. Use `actions/github-script` with open-issue deduplication to prevent alert fatigue.
6. **Atomic file writes** -- Both performance and CI research recommended write-to-temp-then-rename pattern to prevent partial artifacts.
7. **Repeats increased to 3** -- Performance review found 2 repeats cannot distinguish regression from noise; 3 repeats adds negligible cost but meaningful statistical reliability.
8. **Security hardening** -- Dedicated CI API key, step-level secret scoping, MAX_EVALUATIONS hard cap, raw `fetch` over `openai` SDK, `--dry-run` mode.
9. **Report path confirmed** -- Pattern review confirmed `reports/ab/` is correct (matches `reports/` for script output; `docs/reports/` is for human-authored analysis).
10. **AEST cron scheduling** -- CI research provided UTC-to-AEST day-of-week shift patterns (weekday nightly = `30 18 * * 0-4` UTC).

### New Considerations Discovered

- **Model drift detection** needs canary prompts (fixed sentinels) to distinguish code regressions from upstream model changes.
- **Consecutive run confirmation** (2-3 runs showing regression) before alerting prevents single-run outlier noise.
- **Suite versioning** should be embedded in output metadata, with baseline auto-reset on version bump.
- **Report lifecycle** should use GitHub Actions artifacts for JSON archives (gitignored) and git-committed trend CSV + latest.md for durability.
- **Separation of concerns** -- architecture review recommends extracting report formatting and threshold checking into companion modules alongside eval-ab.ts.

---

## Overview

Shift discoverability A/B evaluation from a correctness gate to a lightweight trend-monitoring system. Keep smoke tests as the release gate, and run AB in a minimal nightly (or 3x/week) schedule with alert-based reporting.

## Problem Statement / Motivation

Current AB evaluation is valuable for routing behavior, but it is over-scoped for routine engineering feedback loops:

- AB is behavioral benchmarking, not functional correctness validation.
- Running AB in PR-critical paths increases cognitive and CI load.
- Existing output volume can be larger than needed for practical decision-making.

We need a smaller, stable benchmark that preserves signal quality while reducing operational overhead.

## Proposed Solution

Implement a "Minimal AB Mode" workflow with:

1. Fixed prompt suite (8-12 prompts) focused on high-signal routing confusion pairs.
2. Low-repeat sampling (`repeats=3`) with deterministic seed sets for comparability.
3. Non-blocking scheduled execution (weekday nightly).
4. Alert thresholds based on regression deltas, not pass/fail PR gates.
5. Compact outputs:
   - Trend CSV (git-committed, append-only)
   - Concise markdown summary at `reports/ab/latest.md` (git-committed)
   - Archived raw JSON under `reports/ab/archive/` (gitignored, uploaded as CI artifacts)

### Research Insights

**Best Practices (from eval harness research):**
- Version the prompt suite explicitly (e.g., `minimal-v1`). Any edit to prompt text, expected answers, or confusion pairs bumps the version.
- Record git commit hash, model version string, and per-prompt seed values in every output JSON.
- Pin the model to a specific version (e.g., `gpt-4.1-mini-2025-04-14`) rather than a floating alias. Document that model retirement breaks reproducibility.
- OpenAI's `seed` parameter provides best-effort (not guaranteed) determinism. Trend lines will have irreducible variance -- calibrate thresholds against observed baseline variance.

**Performance Considerations:**
- 2 variants x 10 prompts x 3 repeats = 60 API calls per run. At gpt-4.1-mini pricing, well under $0.10/run.
- Sequential execution is fine for nightly CI. 60 calls x ~1s each = ~60 seconds of API time. No parallelization needed.
- Set per-call timeout of 10 seconds with single retry (2s backoff). A hung request should not block the entire run.

**Simplicity Decision: Binary pass/fail over three-tier alerting.**
Yellow introduces ambiguity -- what do you *do* with a yellow result? If the answer is "look at it manually," that is the same as no alert. Start binary. Add tiers if a real need emerges.

**Simplicity Decision: Drop dedicated CSV writer.**
JSON already exists as the raw format. The trend CSV is a single-line append per run -- no library needed, just string concatenation with `.join(',')`. If someone needs spreadsheet-friendly CSV in the future, a one-liner script generates it from JSON.

---

## Technical Considerations

- **Existing harness reuse:** Extend `scripts/discoverability/eval-ab.ts` with `--suite minimal` flag, following the existing `--suite core|stress` pattern.
- **Workflow boundaries:** Keep PR workflow blocking checks to unit/typecheck/smoke in `.github/workflows/pr-quality.yml`.
- **Determinism:** Prompt set and sampling parameters must be explicitly versioned. Add `PROMPTS_MINIMAL` const array following existing `PROMPTS_CORE`/`PROMPTS_STRESS` pattern.
- **Cost/rate control:** Hard cap via `MAX_EVALUATIONS = 100` constant. Track cumulative `usage.total_tokens` across calls; abort if exceeding 100,000 tokens.
- **Reporting path hygiene:** Establish stable report paths under `reports/ab/`.

### Research Insights

**Pattern Consistency (from codebase analysis):**
- `reports/ab/` is correct -- matches existing `reports/` for machine-generated output. `docs/reports/` is for human-authored analysis.
- Threshold config file has no precedent in this repo. All script-local parameters use inline constants and CLI arg defaults via `parseArg`/`parseIntArg`/`parseFloatArg`.
- Existing `eval-ab.ts` already defines prompt sets as top-level const arrays. Adding `PROMPTS_MINIMAL` follows the same shape.
- Workflow should be named `discoverability-ab.yml` (by concern, not trigger type -- matching `security.yml`, `codeql.yml` pattern).

**Architecture (from architecture review):**
- Risk of overloading eval-ab.ts with too many responsibilities (mode switching, CSV generation, markdown templating, threshold evaluation, alerting). Consider extracting into companion modules:
  ```
  scripts/discoverability/
    eval-ab.ts          # Evaluator (exists, extend with mode flag)
    format-report.ts    # CSV + markdown generation (new)
    check-thresholds.ts # Threshold evaluation + exit code (new)
  ```
- The scheduled workflow would pipeline: `eval-ab.ts --suite=minimal` -> `format-report.ts` -> `check-thresholds.ts`.

**Security (from security review):**
- Use raw `fetch` instead of `openai` npm package. The OpenAI REST API for chat completions is a single POST endpoint. Eliminates ~15+ transitive dependencies.
- Scope `OPENAI_API_KEY` to the single workflow step that needs it (step-level `env`, not job-level).
- Create a dedicated OpenAI API key for CI with a spending cap on the OpenAI dashboard.
- Implement `--dry-run` flag from the start for local development and PR validation without spending tokens.
- Filter raw API responses before persisting: keep only `choices[0].message`, `usage`, `model`. Strip `system_fingerprint`, `x-request-id`.
- For CSV output, prefix any cell starting with `=`, `+`, `-`, `@` with a single quote to prevent formula injection.

---

## System-Wide Impact

- **Interaction graph**: CI scheduled workflow triggers AB script -> AB script calls model API -> writes JSON/CSV/Markdown reports -> threshold checker evaluates deltas -> creates/updates GitHub Issue on regression.
- **Error propagation**: API/network errors should mark AB job as "degraded" and report explicitly, without failing PR checks. Preserve last known stable summary on API failure.
- **State lifecycle risks**: Report writes should be atomic (temp file + rename) to avoid partial `latest.md`/CSV when job is interrupted.
- **API surface parity**: Any prompt-set or threshold changes must be reflected consistently across script args, report parser, and workflow config.
- **Integration test scenarios**:
  - Scheduled run generates all expected artifacts.
  - Alert evaluator flags regression exceeding threshold.
  - No-alert run writes pass summary with zero manual review required.
  - Cold start produces "insufficient baseline" status, not false alert.

### Research Insights

**Atomic Writes (from CI research):**
```typescript
import { renameSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const dir = dirname(targetPath)
  const tmpPath = join(dir, `.${basename(targetPath)}.tmp.${process.pid}`)
  try {
    await Bun.write(tmpPath, content)
    renameSync(tmpPath, targetPath)
  } catch (err) {
    try { (await import('node:fs')).unlinkSync(tmpPath) } catch {}
    throw err
  }
}
```

**Concurrency Guard (from CI research):**
Add to workflow YAML to prevent overlapping runs:
```yaml
concurrency:
  group: discoverability-ab
  cancel-in-progress: true
```

---

## SpecFlow Analysis (Applied)

### Coverage Gaps Identified

- Weekly baseline definition is ambiguous (rolling 7-day mean vs previous run).
- "Failure rate threshold" is not yet numerically defined.
- Wildcard monthly rotation ownership and update process are unspecified.

### Edge Cases Added to Plan

- Missing prior-period baseline should produce "insufficient baseline" status, not false alert.
- API outage should produce degraded result and preserve last known stable summary.
- Prompt-set edits should be treated as fixture changes and reset baseline window metadata.

### Research Insights (from spec flow analysis)

**16 gaps identified. 4 critical questions that block implementation:**

1. **Notification channel** -- Resolved: Use GitHub Issue creation with `eval-regression` label. Deduplication via checking for existing open issues before creating new ones. On resolution, auto-close the issue.

2. **Threshold definitions** -- Resolved: Use sigma-based thresholds from rolling 10-run window. Pass if current run is within 2 sigma of baseline mean. Fail if beyond 2 sigma. Require 2 consecutive failing runs before creating an alert issue (prevents single-run outlier noise).

3. **Minimum baseline runs (N)** -- Set N=5 globally. Approximately 1 work-week if nightly. System runs in "observation mode" (collects data, does not alert) until baseline is valid.

4. **Fixture change baseline reset** -- Full reset on suite version bump. First run after version bump is marked as baseline in the trend CSV. Alert thresholds do not fire until N new runs accumulate.

**Additional flow gaps addressed:**

- **Alert deduplication:** If Monday's run fails and Tuesday's run still fails, comment on the existing open issue instead of creating a second one.
- **Return to green:** Auto-close the regression issue with a comment when metrics return within bounds.
- **Concurrent runs:** `concurrency` group in workflow YAML serializes runs. `workflow_dispatch` and cron cannot conflict.
- **Artifact retention:** Set `retention-days: 30` on JSON archive artifacts. Trend CSV is durable (git-committed).
- **Cold start visibility:** "Insufficient baseline" status appears in `latest.md` and `$GITHUB_STEP_SUMMARY`. Workflow shows as green during cold start (no alert).

---

## Implementation Phases

### Phase 1: End-to-End Minimal Mode (ships working value)

- Extend `eval-ab.ts` with `--suite minimal`:
  - `PROMPTS_MINIMAL` const array (8-12 high-signal confusion pair prompts)
  - `repeats=3` (hardcoded for minimal mode)
  - Fixed seed set (hardcoded, documented)
  - Suite version ID embedded in output metadata (e.g., `minimal-v1`)
  - `--dry-run` flag for local development
  - `MAX_EVALUATIONS = 100` hard cap
  - Per-call 10s timeout with single retry
- Add `format-report.ts` (or inline in eval-ab.ts initially):
  - Trend CSV row append (atomic write)
  - `reports/ab/latest.md` summary (atomic write)
  - `reports/ab/archive/{timestamp}.json` (atomic write)
- Add `check-thresholds.ts` (or inline initially):
  - Rolling 10-run baseline from trend CSV
  - Minimum 5 runs for valid baseline
  - 2-sigma threshold with absolute noise floor
  - Binary pass/fail exit code
  - Consecutive run confirmation (2 runs)
- Add `discoverability-ab.yml` workflow:
  - Cron: `30 18 * * 0-4` (weekday nightly at 04:30 AEST)
  - `workflow_dispatch` with `force_baseline` boolean input
  - `concurrency: { group: discoverability-ab, cancel-in-progress: true }`
  - `timeout-minutes: 15`
  - `step-security/harden-runner` with `egress-policy: audit`
  - `OPENAI_API_KEY` scoped to evaluation step only
  - Permissions: `contents: write`, `issues: write`
  - Git-commit trend CSV and latest.md with `[skip ci]`
  - Upload JSON archive as artifact with `retention-days: 30`
  - GitHub Issue creation on regression (with deduplication)
  - Auto-close issue on return to green
- Update `.gitignore`: add `reports/ab/archive/`
- Update CLAUDE.md CI/CD table with new workflow

### Phase 2: On-Demand + Maintenance

- Add pre-release on-demand trigger documentation
- Document quarterly prompt-set review process (in CONTRIBUTING.md or docs/)
- Add 2-3 canary prompts (fixed sentinels for model drift detection)

### Research Insights

**Simplicity (from simplicity review):**
- Original 4-phase plan collapsed to 2 phases. Phase 1 and 2 of original plan were coupled (cannot test mode without output). Phase 4 (quarterly review) is a process doc, not code.
- Threshold config file eliminated in favor of inline constants. Promote to config only if thresholds change frequently.
- Three-tier alerting (green/yellow/red) eliminated in favor of binary pass/fail. Add tiers when a concrete use case demands them.
- Archived raw JSON is available via CI artifacts -- no need for a custom archive system on day one.

**TypeScript Quality (from TypeScript review):**
- Use string literal union for suite IDs: `type SuiteId = 'full' | 'minimal'`
- Use discriminated union for suite config with literal types (e.g., `repeats: 3` on minimal)
- Use `as const satisfies ThresholdConfig` pattern for threshold constants
- Keep comparison function pure -- takes data in, returns result out. No file I/O inside comparison logic.
- All interface fields should use `readonly`. Arrays should use `readonly T[]`.
- Validate JSON at serialization boundaries -- `JSON.parse` returns `unknown`, use type guards.
- Versioned JSON envelope with `version: 1` literal type for future schema evolution.

**Performance (from performance review):**
- Write one CSV row per run (append), not one CSV per run. At 200 bytes/row, 3x/week = 375 KB/year. Negligible.
- Store rolling baseline separately (`baseline.json`) to avoid reparsing all history on every run. Each run reads last baseline + appends new data point.
- Set artifact retention to 30 days. JSON archives are diagnostic, not permanent record.

---

## Acceptance Criteria

- [x] Minimal AB mode runs with a fixed 8-12 prompt suite and `repeats=3`.
- [x] PR workflows do not hard-fail based on AB benchmark results.
- [x] Scheduled AB workflow runs weekday nightly and is non-blocking.
- [x] Alerting triggers only when regression exceeds 2-sigma from rolling baseline for 2 consecutive runs.
- [x] Cold start (< 5 baseline runs) produces "insufficient baseline" status, not false alerts.
- [x] Outputs are limited to:
  - [x] Trend CSV row (git-committed, append-only)
  - [x] `reports/ab/latest.md` concise summary (git-committed)
  - [x] Archived raw JSON (gitignored, CI artifact with 30-day retention)
- [x] On-demand AB run exists for major release validation via `workflow_dispatch`.
- [x] Quarterly prompt-set review process is documented.
- [x] `--dry-run` mode exists for local development without API calls.
- [x] `MAX_EVALUATIONS` hard cap prevents runaway API calls.
- [x] GitHub Issue with `eval-regression` label created on regression (deduplicated).
- [x] Issue auto-closed on return to green.

---

## Success Metrics

- AB runtime and token cost reduced versus current full benchmark runs.
- Zero AB-driven PR gating incidents (AB no longer blocks PR merges).
- Alert precision: alerts correspond to meaningful regressions, not noise. Target <10% false positive rate after calibration phase.
- Team review time on AB outputs drops to exception-only (alert-triggered) review.

---

## Dependencies & Risks

### Dependencies

- Existing evaluator script: `scripts/discoverability/eval-ab.ts`
- Existing benchmark knowledge: `docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md`
- GitHub Actions scheduling and report persistence strategy
- OpenAI API access with dedicated CI key and spending cap

### Risks

- **Threshold misconfiguration** may cause noisy alerts or missed regressions.
- **Prompt drift** can invalidate trend comparability.
- **Model/provider drift** can shift routing behavior independent of repo changes.
- **Runaway API calls** from loop bugs or misconfigured repeats.

### Mitigations

- Version and lock prompt sets and sampling config. Suite version ID in output metadata.
- Track baseline window metadata in report output. Auto-reset baseline on suite version bump.
- Recalibrate thresholds after first 2-4 weeks of observed data (observation mode).
- Add canary prompts (fixed sentinels) for model drift detection -- if canaries degrade but code hasn't changed, it's model drift.
- `MAX_EVALUATIONS` hard cap, per-call timeouts, `--dry-run` mode, `timeout-minutes` on workflow.
- Consecutive run confirmation (2 runs) before alerting prevents single-run outlier noise.

### Research Insights

**Model Drift Detection (from threshold research):**
- Maintain 2-3 "canary" prompts with known-good reference outputs. These never change.
- If canary scores shift but code/prompts haven't changed, attribute to model drift.
- Track output fingerprint metrics (avg token length, vocabulary diversity, refusal rate) for drift signal.
- Change attribution matrix: canary degraded + no code change = model drift; code changed + canary stable = code regression.

**Security Hardening (from security review):**
- Prefer raw `fetch` over `openai` npm package (eliminates ~15+ transitive dependencies).
- Create dedicated CI OpenAI API key with spending cap on OpenAI dashboard.
- Scope API key to single workflow step (`env` on step, not job).
- Filter API responses before persisting (strip `system_fingerprint`, `x-request-id`).
- Hard cap: `MAX_EVALUATIONS = 100`, `MAX_TOKENS = 100000`.
- First live run via `workflow_dispatch` (manual, monitored). Enable cron only after successful manual run.

**CI Scheduling (from CI research):**
- Cron `30 18 * * 0-4` = weekday nightly at 04:30 AEST (Sunday-Thursday UTC = Monday-Friday AEST due to day-of-week shift).
- Avoid :00 of any hour (congestion). Offset by 30 minutes.
- Always pair `schedule` with `workflow_dispatch` for debugging and on-demand runs.
- `[skip ci]` in trend commit message prevents infinite workflow loops.
- Branch protection on main may block bot commits -- plan for `github-actions[bot]` bypass rule or use a dedicated reports branch.

---

## Recommendations

1. Set initial thresholds using sigma-based calculation (2-sigma from rolling 10-run baseline) and tune after 2-4 weeks of observed data. Start in observation mode.
2. Use inline constants for thresholds (e.g., `const SIGMA_THRESHOLD = 2.0`, `const MIN_BASELINE_RUNS = 5`), consistent with how `eval-ab.ts` handles its configuration. Expose as CLI args via existing `parseFloatArg` pattern for override.
3. Include "No additional operational monitoring required" note in PRs touching only AB reporting logic when production runtime is unaffected.
4. First deployment: run via `workflow_dispatch` (manual, monitored) before enabling the cron schedule. Validate that reports generate correctly, thresholds compute sensibly, and no runaway API calls occur.
5. Keep eval-ab.ts focused on evaluation logic. If it grows beyond ~700 lines with the minimal mode additions, extract reporting and threshold checking into companion modules in the same directory.

---

## Sources & References

- Institutional learning: [docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md](../solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md)
- Existing harness: [scripts/discoverability/eval-ab.ts](../../scripts/discoverability/eval-ab.ts)
- Existing result report style: [docs/reports/2026-03-04-discoverability-ab-results.md](../reports/2026-03-04-discoverability-ab-results.md)
- PR gating workflow baseline: [.github/workflows/pr-quality.yml](../../.github/workflows/pr-quality.yml)
- Smoke test gating context: [docs/testing/smoke-tests.md](../testing/smoke-tests.md)

### External References (from research agents)

- [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness) -- Reproducibility practices (seed control, task versioning, per-sample logging)
- [benchmark-action/github-action-benchmark](https://github.com/benchmark-action/github-action-benchmark) -- GitHub Pages trend visualization, threshold alerting
- [PromptLayer: Why LLM Evaluation Results Aren't Reproducible](https://blog.promptlayer.com/why-llm-evaluation-results-arent-reproducible-and-what-to-do-about-it/) -- Seed/temperature limitations
- [Pragmatic Engineer: Evals Guide](https://newsletter.pragmaticengineer.com/p/evals) -- Golden datasets, CI integration
- [Braintrust: LLM Evaluation Metrics Guide](https://www.braintrust.dev/articles/llm-evaluation-metrics-guide) -- Alert classification, threshold calibration
- [DasRoot: Monitor LLM Drift in Production](https://dasroot.net/posts/2026/02/monitor-llm-drift-production/) -- Fingerprint-based drift detection
- [Statsig: Model Drift Detection](https://www.statsig.com/perspectives/model-drift-detection) -- Distribution shift monitoring
