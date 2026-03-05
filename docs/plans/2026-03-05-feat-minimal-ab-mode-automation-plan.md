---
title: "Minimal AB Mode for Discoverability Trend Detection"
type: feat
status: active
date: 2026-03-05
priority: p2
---

# Minimal AB Mode for Discoverability Trend Detection

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
2. Low-repeat sampling (`repeats=2`) with deterministic seed sets for comparability.
3. Non-blocking scheduled execution (nightly or 3x/week).
4. Alert thresholds based on regression deltas, not pass/fail PR gates.
5. Compact outputs:
   - Trend CSV
   - concise markdown summary at `reports/ab/latest.md`
   - archived raw JSON for deep dives only when alerts trigger

## Technical Considerations

- **Existing harness reuse:** Extend `scripts/discoverability/eval-ab.ts` rather than creating a second evaluator.
- **Workflow boundaries:** Keep PR workflow blocking checks to unit/typecheck/smoke in `.github/workflows/pr-quality.yml`.
- **Determinism:** Prompt set and sampling parameters must be explicitly versioned and unchanged between routine runs.
- **Cost/rate control:** Minimal mode should cap model calls through prompt count and repeat count.
- **Reporting path hygiene:** Establish stable report paths under `reports/ab/` for automation and human scanning.

## System-Wide Impact

- **Interaction graph**: CI scheduled workflow triggers AB script -> AB script calls model API -> writes JSON/CSV/Markdown reports -> optional alerting step evaluates thresholds and posts summary.
- **Error propagation**: API/network errors should mark AB job as "degraded" and report explicitly, without failing PR checks.
- **State lifecycle risks**: Report writes should be atomic to avoid partial `latest.md`/CSV when job is interrupted.
- **API surface parity**: Any prompt-set or threshold changes must be reflected consistently across script args, report parser, and workflow config.
- **Integration test scenarios**:
  - Scheduled run generates all expected artifacts.
  - Alert evaluator flags latency regression >20% WoW.
  - Alert evaluator flags correctness drop >10%.
  - No-alert run writes green summary with zero manual review required.

## SpecFlow Analysis (Applied)

### Coverage Gaps Identified

- Weekly baseline definition is ambiguous (rolling 7-day mean vs previous run).
- "Failure rate threshold" is not yet numerically defined.
- Wildcard monthly rotation ownership and update process are unspecified.

### Edge Cases Added to Plan

- Missing prior-period baseline should produce "insufficient baseline" status, not false alert.
- API outage should produce degraded result and preserve last known stable summary.
- Prompt-set edits should be treated as fixture changes and reset baseline window metadata.

## Implementation Phases

### Phase 1: Minimal Mode Contract

- Add explicit minimal mode inputs to AB evaluator (or wrapper script):
  - suite id (`minimal`)
  - `repeats=2`
  - fixed seed set
  - report targets under `reports/ab/`
- Define threshold config file (or constants) for:
  - latency regression limit
  - correctness regression limit
  - failure-rate limit

### Phase 2: Reporting + Alerts

- Add trend CSV writer.
- Add markdown summary writer (`reports/ab/latest.md`).
- Add threshold evaluation step:
  - classify `green` / `yellow` / `red`
  - include concise reason codes in summary.

### Phase 3: Workflow Split + Scheduling

- Keep PR gate as: unit + typecheck + smoke (blocking).
- Add scheduled AB workflow (nightly or 3x/week) as non-blocking trend job.
- Add on-demand trigger before major release tags.

### Phase 4: Maintenance Cadence

- Add quarterly review checklist for prompt set refresh (2-3 wildcard replacements max).
- Require small explicit PR rationale for any benchmark fixture changes.

## Acceptance Criteria

- [ ] Minimal AB mode runs with a fixed 8-12 prompt suite and `repeats=2`.
- [ ] PR workflows do not hard-fail based on AB benchmark results.
- [ ] Scheduled AB workflow runs nightly (or 3x/week) and is non-blocking.
- [ ] Alerting triggers only when configured thresholds are exceeded:
  - [ ] latency regression >20% week-over-week
  - [ ] correctness drop >10%
  - [ ] failure rate above configured threshold
- [ ] Outputs are limited to:
  - [ ] trend CSV
  - [ ] `reports/ab/latest.md` concise summary
  - [ ] archived raw JSON for drill-down
- [ ] On-demand AB run exists for major release validation.
- [ ] Quarterly prompt-set review process is documented.

## Success Metrics

- AB runtime and token cost reduced versus current full benchmark runs.
- Zero AB-driven PR gating incidents (AB no longer blocks PR merges).
- Alert precision: alerts correspond to meaningful regressions, not noise.
- Team review time on AB outputs drops to exception-only (alert-triggered) review.

## Dependencies & Risks

### Dependencies

- Existing evaluator script: `scripts/discoverability/eval-ab.ts`
- Existing benchmark knowledge: `docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md`
- GitHub Actions scheduling and report persistence strategy

### Risks

- **Threshold misconfiguration** may cause noisy alerts or missed regressions.
- **Prompt drift** can invalidate trend comparability.
- **Model/provider drift** can shift routing behavior independent of repo changes.

### Mitigations

- Version and lock prompt sets and sampling config.
- Track baseline window metadata in report output.
- Recalibrate thresholds after first 2-4 weeks of observed data.

## Recommendations

1. Set initial failure-rate threshold explicitly in this implementation (for example 5%) and tune after baseline collection.
2. Use a single source-of-truth config object/file for prompts, thresholds, and schedule metadata.
3. Include a brief "No additional operational monitoring required" note in PRs touching only AB reporting logic when production runtime is unaffected.

## Sources & References

- Institutional learning: [docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md](../solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md)
- Existing harness: [scripts/discoverability/eval-ab.ts](../../scripts/discoverability/eval-ab.ts)
- Existing result report style: [docs/reports/2026-03-04-discoverability-ab-results.md](../reports/2026-03-04-discoverability-ab-results.md)
- PR gating workflow baseline: [.github/workflows/pr-quality.yml](../../.github/workflows/pr-quality.yml)
- Smoke test gating context: [docs/testing/smoke-tests.md](../testing/smoke-tests.md)
