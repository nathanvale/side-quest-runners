---
created: 2026-03-04
title: TSC Runner Uplift - Staff Recommendation and Rollout Report
type: brainstorm
tags: [mcp, tsc-runner, bun-runner, biome-runner, prompt-engineering, output-schema, observability, logtape, reliability]
project: dx-tsc-runner
status: complete
builds-on:
  - side-quest-marketplace: docs/research/2026-03-03-mcp-best-practices-prompt-engineering.md
  - side-quest-marketplace: docs/research/2026-03-03-tsc-incremental-bun-subprocess-patterns.md
  - side-quest-marketplace: docs/research/2026-03-04-logtape-mcp-server-observability.md
reviewed-by: staff-engineering-opinion (2026-03-04)
---

# TSC Runner Uplift

## Executive Summary

We should use `tsc-runner` as the proving ground for a gold-standard MCP runner pattern, then roll the same pattern into `bun-runner` and `biome-runner` only after one stable release cycle.

This uplift should optimize for three outcomes:

1. Better tool routing by LLMs through high-signal descriptions and explicit contracts (`title`, `outputSchema`, annotations).
2. Better runtime reliability through incremental checks, strict env allowlisting, structured failures, and parser hardening.
3. Better operational clarity through dual-channel logging with per-request isolation and zero stdout pollution.

Staff position: sequence discipline matters more than speed. The highest-risk decision is whether to keep `@side-quest/core` or move directly to raw MCP SDK. We must close that with a short, explicit Phase 0 decision before touching broad implementation.

## Recommendation

### Primary Recommendation

Keep `@side-quest/core` only if Phase 0 confirms it still adds material value for lifecycle and safety utilities. In all cases, move response formatting and logging ownership into this repo.

### Why this is the right bet

- It minimizes migration risk while still giving us full control over the layers where runner requirements are specific (response shape and logging behavior).
- It gives us a reversible path if raw SDK ergonomics are not worth immediate migration cost.
- It avoids forcing three runners through architecture churn before the pattern is proven.

### Alternative path

If Phase 0 shows wrapper value is marginal or negative, migrate tsc-runner directly to raw `@modelcontextprotocol/sdk@^1.27.1`, prove parity, then apply to the other runners.

## Key Decisions and Rationale

### 1) Core dependency decision is a gate, not an implementation detail

Decision needed:
- Keep `@side-quest/core` slim for lifecycle/spawn/validation only, or
- Remove it and use raw MCP SDK.

Rationale:
- This choice impacts all downstream interfaces, imports, and test setup.
- Deferring this decision creates rework in phases A-C.

### 2) Tool contract quality is first-class product work

Required contract for all 7 tools across 3 runners:
- High-clarity description (what/when/returns/boundaries)
- `title`
- `outputSchema`
- Correct annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`)

Rationale:
- Tool descriptions and schemas are routing and trust primitives for MCP clients.
- Ambiguous contracts cause wrong-tool selection and brittle agent behavior.

### 3) Reliability defaults must be conservative and explicit

`tsc-runner` defaults:
- Enable `--incremental`
- Use strict env allowlist only
- Return structured error codes for operationally distinct failures
- Never return silent-success envelopes when parsing fails

Rationale:
- Reliability issues in runners are expensive because they surface as false confidence to users and agents.

### 4) Logging ownership belongs in-repo for MCP runners

Decision:
- Own response and logging layers in this repo regardless of core decision.

Rationale:
- MCP constraints differ from CLI logging patterns (stdout protocol safety, dual-channel behavior, request-scoped correlation).

## What Changes in `tsc-runner`

### Contract and Prompting

- Rewrite `tsc_check` description with strict routing boundaries.
- Add `title: "TypeScript Type Checker"`.
- Add explicit `outputSchema` for JSON response validation.
- Include TypeScript diagnostic codes (for example `TS2345`) in parsed errors.
- Compact JSON payload output (remove pretty-print whitespace).
- Replace em dashes with `--` for consistency.
- Sync server version with `package.json`.

### Runtime Reliability

- Add `--incremental` support.
- Replace blanket env forwarding with allowlist:
  - `PATH`, `HOME`, `NODE_PATH`, `BUN_INSTALL`, `TMPDIR`
- Add structured error categories:
  - `CONFIG_NOT_FOUND`, `TIMEOUT`, `SPAWN_FAILURE`, `PATH_NOT_FOUND`
- Add parser fallback behavior to prevent silent zero-error output on failed runs.
- Detect and surface likely `.tsbuildinfo` corruption hints.

### Observability

Stage 1:
- Implement local response layer ownership and preserve behavior parity.

Stage 2:
- Implement LogTape dual-channel pipeline:
  - stderr JSONL sink
  - MCP protocol sink bridge
  - request context propagation via `withContext()` and `AsyncLocalStorage`
  - `fingersCrossed` plus `isolateByContext`
  - graceful logger disposal on shutdown

## Execution Plan

### Phase 0: Architecture Gate (must complete first)

1. Audit raw `@modelcontextprotocol/sdk@1.27.1` capability against current core wrapper behavior.
2. Build a minimal raw-SDK proof tool and assess ergonomics.
3. Publish decision memo: keep slim core vs remove core.

Exit criteria:
- Written recommendation with evidence and clear migration impact.

### Phase 0b: Cross-Runner Contract Artifacts (parallel)

1. Produce descriptions for all 7 tools.
2. Define `title`, `outputSchema`, and annotations for all 7 tools.
3. Validate token budgets and disambiguation boundaries.

Exit criteria:
- Copy-paste-ready contract artifact approved for implementation.

### Phase A: Foundation

If keeping core:
- Upgrade MCP SDK in core and verify passthrough for `title` and `outputSchema`.

If dropping core:
- Migrate tsc-runner to raw SDK and preserve existing behavior.

Exit criteria:
- All three runners smoke-test successfully.

### Phase B: `tsc-runner` Contract Uplift

1. Apply description, title, schema, annotation, and payload shape updates.
2. Add TS error code extraction and format hygiene fixes.

Exit criteria:
- Contract tests pass, response schema validates at 100%.

### Phase C: `tsc-runner` Reliability Uplift

1. Add incremental mode and allowlisted env strategy.
2. Add structured errors and parser fallback.
3. Add corruption hinting.

Exit criteria:
- No silent parse failures, timeout/config/path errors correctly categorized.

### Phase D: `tsc-runner` Observability Uplift

1. Stage 1 response layer ownership.
2. Stage 2 LogTape dual-channel rollout.

Exit criteria:
- No stdout contamination, request-level isolation verified under concurrency.

### Phase E: Cross-Runner Rollout

1. Port proven pattern to `bun-runner` then `biome-runner`.
2. Run parity checklist and close deltas.

Exit criteria:
- All three runners satisfy parity and contract checks.

## Non-Negotiable Gates

1. Post-0 gate: architecture decision memo complete.
2. Post-0b gate: 7-tool contract artifact approved.
3. Post-A gate: smoke tests green across all runners.
4. Post-C gate: zero silent failures and no env leakage.
5. Post-D gate: logging isolation and protocol safety proven.
6. Post-E gate: parity checklist fully green.

## Risks and Mitigations

### Risk: premature migration away from core creates churn
Mitigation:
- Time-box Phase 0 and force a documented decision before implementation.

### Risk: schema/description drift across runners
Mitigation:
- Single source contract artifact in research docs; parity checks in CI.

### Risk: incremental cache corruption under concurrent processes
Mitigation:
- Detect corruption signatures and return actionable remediation guidance.

### Risk: logging noise or protocol interference
Mitigation:
- Keep stdout protocol-only, enforce sink caps/sampling, and verify with integration tests.

## Success Metrics

1. Contract validity: 100% schema-valid JSON responses.
2. Reliability: zero silent parse failures.
3. Security: no blanket env pass-through.
4. Performance: warm `tsc_check` p95 under 3 seconds.
5. Consistency: parity checklist passes all three runners.
6. Observability: request-isolated dual-channel logging active on all runners.

## Cross-Runner Parity Checklist

| Capability | tsc-runner | bun-runner | biome-runner |
|---|---|---|---|
| Description quality (what/when/returns/boundaries) | Required | Required | Required |
| `title` present | Required | Required | Required |
| `outputSchema` present | Required | Required | Required |
| Compact JSON response | Required | Required | Required |
| Env allowlist | Required | Required | Required |
| Version sync with package | Required | Required | Required |
| No em dashes | Required | Required | Required |
| Structured error codes | Required | Required | Required |
| Correct annotations | Required | Required | Required |
| Contract tests | Required | Required | Required |
| Dual-channel logging | Required | Required | Required |
| Request isolation (`fingersCrossed`) | Required | Required | Required |
| Graceful logging shutdown | Required | Required | Required |

## Team Report Format (for standup or PRD update)

- Decision made at Phase 0:
  - `keep slim core` or `drop core`
- Current phase:
  - A/B/C/D/E
- Gate status:
  - `green` or `blocked`, with blocker owner
- Delta since last update:
  - completed changes
  - open risks
  - next irreversible decision

## Sources

- [MCP Tools spec (2025-06-18)](https://modelcontextprotocol.io/docs/concepts/tools) -- `title`, `outputSchema`
- [MCP Logging spec (2025-03-26)](https://modelcontextprotocol.io/specification/2025-03-26/server/utilities/logging)
- [MCP best practices research](https://github.com/nathanvale/side-quest-marketplace/blob/main/docs/research/2026-03-03-mcp-best-practices-prompt-engineering.md)
- [tsc incremental + Bun subprocess research](https://github.com/nathanvale/side-quest-marketplace/blob/main/docs/research/2026-03-03-tsc-incremental-bun-subprocess-patterns.md)
- [LogTape MCP observability research](https://github.com/nathanvale/side-quest-marketplace/blob/main/docs/research/2026-03-04-logtape-mcp-server-observability.md)
- `@side-quest/core@0.1.1` source audit
- Staff engineering review (2026-03-04)
