---
title: "Discoverability A/B Results: Current vs Half-Cut Descriptions"
date: 2026-03-04
status: complete
model: gpt-4.1-mini
---

# Discoverability A/B Results

Live LLM routing evaluation was run using `OPENAI_API_KEY` against two description variants:

- `current`: descriptions from runner source today
- `half-cut`: compressed set from token-bloat cross-check

Tool execution was **not** invoked. This benchmark measures tool-selection quality only.

## How It Was Measured

- Harness: [scripts/discoverability/eval-ab.ts](scripts/discoverability/eval-ab.ts)
- Router: OpenAI chat completions (`gpt-4.1-mini`)
- Output per trial: ranked picks (`first`, `second`) from allowed tool names
- Metrics:
  - first-choice accuracy
  - confusion-pair accuracy
  - mean extra calls proxy (`0` if first correct, `1` if second correct, `2` if missed)

Reports:

- [reports/discoverability-ab-core.json](reports/discoverability-ab-core.json)
- [reports/discoverability-ab-stress.json](reports/discoverability-ab-stress.json)

## Results

### Core Suite (`10` prompts, `5` repeats, `50` trials per variant)

- Current:
  - first-choice accuracy: `1.000`
  - mean extra calls: `0.000`
- Half-cut:
  - first-choice accuracy: `1.000`
  - mean extra calls: `0.000`
- Delta (half-cut - current):
  - first-choice accuracy: `0.000`
  - mean extra calls: `0.000`

### Stress Suite (`22` prompts, `5` repeats, `110` trials per variant)

- Current:
  - first-choice accuracy: `0.9091` (`100/110`)
  - mean extra calls: `0.0909`
- Half-cut:
  - first-choice accuracy: `0.9727` (`107/110`)
  - mean extra calls: `0.0273`
- Delta (half-cut - current):
  - first-choice accuracy: `+0.0636`
  - mean extra calls: `-0.0636`

## Where Misroutes Happened (Stress Suite)

Current variant misses:

1. `S08: "fix formatting drift before merge"`  
   - expected: `biome_lintFix`  
   - selected: `biome_formatCheck` (first), `biome_lintFix` (second)
2. `S10: "full test run after refactor"`  
   - expected: `bun_runTests`  
   - selected: `tsc_check` (first), `bun_runTests` (second)

Half-cut variant misses:

1. `S08` once with same pattern as above (`biome_formatCheck` first).
2. `S10` twice with same pattern as above (`tsc_check` first).

## Staff Interpretation

The half-cut set is not only smaller; in this benchmark it is also more robust under harder phrasing. The explicit boundaries and cross-references appear to preserve or improve discoverability despite a large token reduction.

## Decision Signal

- Token reduction target was met (~54% vs long-form proposal).
- Discoverability gate (`<=2%` absolute regression) is exceeded in the positive direction on stress prompts.

Recommendation: proceed with half-cut descriptions, then keep this benchmark in CI/nightly as a regression guard.
