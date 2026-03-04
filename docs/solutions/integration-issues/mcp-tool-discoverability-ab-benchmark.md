---
created: 2026-03-04
title: MCP Tool Discoverability Validation with A/B Routing Benchmark
type: solution
tags: [mcp, discoverability, prompt-engineering, token-optimization, evaluation]
project: side-quest-runners
status: complete
category: integration-issues
symptom: "Description compression had no proof discoverability would hold"
root_cause: "Token metrics were used as a proxy for routing quality without a live-model selection benchmark"
related:
  - /Users/nathanvale/code/side-quest-runners/docs/research/2026-03-04-token-bloat-discoverability-cross-check.md
  - /Users/nathanvale/code/side-quest-runners/docs/research/2026-03-04-cross-runner-contract-artifacts.md
  - /Users/nathanvale/code/side-quest-runners/docs/reports/2026-03-04-discoverability-ab-results.md
---

# MCP Tool Discoverability Validation with A/B Routing Benchmark

## Problem

We needed to cut tool-description bloat by ~50% while preserving tool discoverability.
The blocker was confidence: token counts alone do not prove an LLM will route to the right tool.

## Symptoms

- Team uncertainty: "How do we know these are discoverable without running the tools?"
- Existing evidence was size-based (`chars`/estimated tokens), not behavior-based.
- No in-repo benchmark existed for first-choice tool routing quality.

## Root Cause

We were using **manifest compactness** as a proxy for **routing correctness**.
Those are correlated but not equivalent. Discoverability is a model behavior problem and requires live routing evaluation.

## What We Did

### 1. Built a real A/B evaluator

Added a harness at:
- `/Users/nathanvale/code/side-quest-runners/scripts/discoverability/eval-ab.ts`

It compares two variants:
- `current` descriptions (from runner code)
- `half-cut` descriptions (compressed set)

For each prompt trial it collects:
- first selected tool
- second selected tool
- first-choice accuracy
- confusion-pair accuracy
- mean extra calls proxy

### 2. Ran live-model routing benchmarks

Used OpenAI routing (`gpt-4.1-mini`) with API calls (not heuristic scoring).

Commands:

```bash
bun scripts/discoverability/eval-ab.ts --suite=core --repeats=5 --temperature=0.2 --out=reports/discoverability-ab-core.json
bun scripts/discoverability/eval-ab.ts --suite=stress --repeats=5 --temperature=0.2 --out=reports/discoverability-ab-stress.json
```

Reports produced:
- `/Users/nathanvale/code/side-quest-runners/reports/discoverability-ab-core.json`
- `/Users/nathanvale/code/side-quest-runners/reports/discoverability-ab-stress.json`
- `/Users/nathanvale/code/side-quest-runners/docs/reports/2026-03-04-discoverability-ab-results.md`

### 3. Baked validated text into contract artifacts

Applied half-cut descriptions into:
- `/Users/nathanvale/code/side-quest-runners/docs/research/2026-03-04-cross-runner-contract-artifacts.md`

## Results

### Core suite (10 prompts, 5 repeats)

- Current: 100% first-choice accuracy
- Half-cut: 100% first-choice accuracy
- Delta: 0.0%

### Stress suite (22 prompts, 5 repeats)

- Current: 90.91% first-choice accuracy, mean extra calls 0.0909
- Half-cut: 97.27% first-choice accuracy, mean extra calls 0.0273
- Delta: +6.36% first-choice, -0.0636 extra calls

## Why This Worked

The compressed descriptions retained the highest-signal routing features:
- explicit action intent (what)
- boundary language (what not to use)
- exact cross-tool references (where to go instead)

So we reduced tokens substantially without removing disambiguation structure.

## Prevention Strategy

1. Never ship description compression based only on token metrics.
2. Require live A/B routing benchmarks for any contract-description rewrite.
3. Keep two suites:
- `core` for regression sanity
- `stress` for ambiguous phrasing and confusion-pair pressure
4. Gate changes on both budget and behavior:
- Token target met
- First-choice regression <= 2% absolute
- Confusion pairs remain >= 95% unless explicitly accepted

## Reusable Pattern

When evaluating MCP tool description changes:

1. Create candidate description set.
2. Run `eval-ab.ts` on `core` and `stress` suites.
3. Inspect misroutes by prompt ID.
4. Adjust only the losing tool descriptions.
5. Re-run until gates pass.
6. Then update contract/research artifacts and implementation.

## Notes and Caveats

- This benchmark measures **selection behavior**, not tool correctness/execution.
- Model/provider changes can shift routing behavior; rerun when model defaults change.
- A temporary harness robustness fix was added to handle duplicate `first/second` outputs from the router.
