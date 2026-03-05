# Discoverability AB Minimal Mode

This job tracks discoverability drift over time for the `minimal-v1` prompt suite.
It is not a PR gate and should be treated as trend monitoring.

## Run On Demand

Use `workflow_dispatch` on `.github/workflows/discoverability-ab.yml`.

Optional input:
- `force_baseline=true`: collect and commit trend data, but skip alert evaluation for that run.

## Nightly Schedule

The workflow runs on:
- `30 18 * * 0-4` UTC

This maps to weekday 04:30 in Melbourne for most of the year.

## Alert Rules

- Rolling baseline window: 10 runs
- Minimum baseline runs: 5
- Threshold: 2-sigma with absolute floor
- Alert trigger: 2 consecutive failing runs
- Cold start behavior: status = `insufficient_baseline` (no alert)

Alerts use a single deduplicated issue labeled `eval-regression`.
When metrics recover, the issue is auto-closed.

## Quarterly Maintenance

Once per quarter:
1. Review minimal prompt quality and routing confusion pairs.
2. Recalibrate thresholds using recent variance in `reports/ab/trend.csv`.
3. Confirm canary prompts (`C01`, `C02`, `C03`) still represent stable sentinel behavior.
4. If prompt semantics change, bump suite version (for example, `minimal-v2`) and allow baseline rebuild.

## Artifacts

- Committed:
  - `reports/ab/trend.csv`
  - `reports/ab/latest.md`
- Archived artifact (30 days retention):
  - `reports/ab/archive/*.json`
