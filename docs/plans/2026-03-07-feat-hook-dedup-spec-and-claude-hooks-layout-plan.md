---
title: Hook Dedup Spec + `claude-hooks` Package Layout
date: 2026-03-07
status: ready
owner: nathanvale
tags: [hooks, token-efficiency, claude-code, mcp, architecture, dedup]
---

# Hook Dedup Spec + `claude-hooks` Package Layout

## Goal

Move hook behavior into this repository so hook behavior and MCP runner behavior are designed together, while keeping the system portable (not permanently locked to Claude Code semantics).

This plan defines:

1. Hook dedup specification (contract, keying, TTL, failure modes)
2. Exact `packages/claude-hooks` layout compatible with existing publish/build patterns

## Why This Direction

- Biggest remaining token waste is hook/MCP duplication.
- Keeping hooks and runners in one repo allows one token strategy and one contract test matrix.
- We can keep platform-specific logic thin (Claude adapter), while keeping dedup/core logic platform-agnostic for future adapters.

## External Contract Research (2026)

### Claude Code hooks constraints we must design for

- Hooks are configured in settings JSON with event + matcher groups.
- Tool events include MCP tools with names like `mcp__<server>__<tool>`.
- Hooks receive JSON on stdin (command hooks) and can return control via:
  - exit codes, or
  - JSON on stdout (exit `0` only)
- Matching hooks run in parallel; identical commands are deduplicated by Claude Code.
- Async hooks (`"async": true`) cannot block/control decisions.
- `PostToolUse` supports `updatedMCPToolOutput` for MCP tools.
- `PreToolUse` top-level `decision/reason` is deprecated for this event; use:
  - `hookSpecificOutput.permissionDecision`
  - `hookSpecificOutput.permissionDecisionReason`

Sources:
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Legacy docs alias: https://docs.anthropic.com/en/docs/claude-code/hooks

### MCP constraints we must preserve

- `structuredContent` is the machine contract and should remain valid JSON per output schema.
- `content` text can be optimized independently.

Sources:
- MCP tools concept: https://modelcontextprotocol.io/docs/concepts/tools
- MCP server tools spec: https://modelcontextprotocol.io/specification/draft/server/tools

## Deprecation / Breaking-Change Check

Checked on 2026-03-07:

- Claude Code hooks: no sunset/shutdown notice found.
- Notable behavior change/deprecation:
  - `PreToolUse` top-level `decision` format is deprecated for that event.
  - We must implement new hook-specific decision fields for compatibility.

## Architecture: Keep Core Portable

To avoid lock-in:

- `packages/claude-hooks` will be an adapter package for Claude hook IO/events.
- Dedup logic and policy should live in platform-neutral modules inside the package (`src/core/*`), with no direct dependency on Claude hook JSON in core APIs.
- Future adapters (for other agent platforms) can reuse the same core modules and persistence format.

## Dedup Specification (Contract + Keying + TTL)

### Scope

- Initial scope: dedup runner-related signals for:
  - `biome` checks/fixes
  - `bun` test checks
  - `tsc` checks
- Events handled:
  - `PostToolUse` and optionally `PostToolUseFailure`
  - `PreToolUse` only for key pre-registration when useful

### Canonical Signal Ownership

- MCP runner output remains canonical diagnostics source.
- Hook output should be one of:
  1. `suppress` (no verbose duplicate details)
  2. `pointer` (short instruction to check MCP tool result)
  3. `fallback-summary` (compact details only if no MCP result arrives within TTL window)

### Dedup Key

Key fields (normalized):

- `platform`: `claude`
- `projectRoot`: realpath of repo root
- `runnerKind`: one of `biome`, `bun`, `tsc`
- `operation`: e.g. `lintCheck`, `lintFix`, `formatCheck`, `runTests`, `testFile`, `coverage`, `typecheck`
- `target`: normalized path/file or normalized selector
- `bucket`: `Math.floor(timestampMs / bucketSizeMs)`

String format:

```text
v1|claude|<projectRoot>|<runnerKind>|<operation>|<target>|<bucket>
```

Hash form:

- `sha256(keyString)` as stable key id (filename-safe)

### TTL + Bucketing

- `bucketSizeMs`: 10_000 (default)
- `eventTtlMs`: 45_000 (default)
- `maxEntries`: 2_000 per repo cache
- storage:
  - primary: file-backed cache under `${TMPDIR}/side-quest-hooks-cache/<repo-hash>.json`
  - in-process memory mirror for hot reads

### Record Shape

```ts
type DedupState = {
  key: string
  createdAtMs: number
  lastUpdatedAtMs: number
  hookSeen: boolean
  mcpSeen: boolean
  lastHookEvent?: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  runnerKind: 'biome' | 'bun' | 'tsc'
  operation: string
  target?: string
}
```

### Decision Algorithm

For each qualifying hook event:

1. Compute dedup key.
2. Read/update dedup record.
3. If `mcpSeen === true` and record age <= `eventTtlMs`:
   - emit pointer/suppressed output (no duplicate diagnostics)
4. Else:
   - emit compact fallback summary (not full structured dump)
5. Mark `hookSeen = true`.

When MCP tool output is observed through hook event context:

- set `mcpSeen = true` for matching key.

### Minimal Hook Output Policy

- Default for dedup hit:
  - JSON output with `hookSpecificOutput.additionalContext` containing one-line pointer.
  - optional `suppressOutput: true` for noisy command hooks.
- Never print full duplicated diagnostics JSON from hook once a matching MCP result exists.

### Failure Modes & Mitigations

1. False-positive dedup (suppressed unrelated event)
- Mitigation: stronger target normalization + short buckets + operation-specific keying

2. False-negative dedup (duplicate still emitted)
- Mitigation: acceptable safety failure; tune key canonicalization and TTL

3. Cache corruption / unreadable file
- Mitigation: fail open (emit compact fallback summary), rebuild cache atomically

4. Race conditions across parallel hooks
- Mitigation: atomic write (`write temp + rename`), monotonic timestamps, last-write-wins

5. Claude JSON parse breakage due to noisy stdout
- Mitigation: hook command mode prints JSON only; log diagnostics to stderr/file

6. Contract drift in Claude hooks
- Mitigation: schema fixtures + CI contract tests pinned to current docs behavior

## `packages/claude-hooks` Exact Layout

```text
packages/claude-hooks/
├── CHANGELOG.md
├── LICENSE
├── README.md
├── bunup.config.ts
├── package.json
├── tsconfig.json
├── mcp/                          # optional helper integration tests/fixtures only
├── src/
│   ├── cli/
│   │   ├── index.ts              # command router
│   │   ├── pretool.ts            # PreToolUse entry
│   │   ├── posttool.ts           # PostToolUse entry
│   │   ├── posttool-failure.ts   # PostToolUseFailure entry
│   │   └── shared-io.ts          # stdin parse / stdout JSON helpers
│   ├── adapters/
│   │   └── claude/
│   │       ├── schema.ts         # Claude event input/output zod schemas
│   │       ├── map-event.ts      # map Claude event -> core intent
│   │       └── response.ts       # produce hookSpecificOutput safely
│   ├── core/
│   │   ├── dedup-key.ts
│   │   ├── dedup-store.ts
│   │   ├── dedup-policy.ts
│   │   ├── runner-kind.ts
│   │   └── types.ts
│   ├── integrations/
│   │   └── runners/
│   │       ├── infer-operation.ts
│   │       └── infer-target.ts
│   └── index.ts                  # exports core + adapter-safe APIs
└── test/
    ├── core/
    │   ├── dedup-key.test.ts
    │   ├── dedup-store.test.ts
    │   └── dedup-policy.test.ts
    ├── adapters/
    │   └── claude-schema.test.ts
    └── cli/
        ├── pretool.test.ts
        └── posttool.test.ts
```

## Package.json Shape (Match Existing Publish Flow)

Use same conventions as other runner packages:

- `type: "module"`
- `build`: `bunx bunup`
- `test`: `bun test`
- `typecheck`: `tsc --noEmit`
- `publishConfig.access = "public"`
- provenance on publish

Proposed `bin`:

```json
{
  "bin": {
    "sq-claude-hook": "./dist/index.js",
    "sq-claude-hook-pretool": "./dist/pretool.js",
    "sq-claude-hook-posttool": "./dist/posttool.js",
    "sq-claude-hook-posttool-failure": "./dist/posttool-failure.js"
  }
}
```

CLI style:

```bash
sq-claude-hook pretool
sq-claude-hook posttool
sq-claude-hook posttool-failure
```

## Claude Settings Integration Pattern

Example matcher setup (project-level):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__biome-runner__.*|mcp__bun-runner__.*|mcp__tsc-runner__.*",
        "hooks": [
          {
            "type": "command",
            "command": "sq-claude-hook posttool"
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "mcp__biome-runner__.*|mcp__bun-runner__.*|mcp__tsc-runner__.*",
        "hooks": [
          {
            "type": "command",
            "command": "sq-claude-hook posttool-failure"
          }
        ]
      }
    ]
  }
}
```

## Compatibility Strategy (Codex + Other Platforms)

- Core modules (`src/core`) contain no Claude-specific shapes.
- Claude adapter (`src/adapters/claude`) is isolated.
- Future adapters can map platform events into the same `DedupIntent` contract.
- If a platform has no hooks (Codex today), core logic is still reusable in:
  - wrapper CLI flows
  - middleware at tool orchestration boundary
  - future event hooks if/when available

## Rollout Plan

1. Introduce package with feature flag:
   - `SQ_HOOK_DEDUP_ENABLED=0|1`
2. Shadow mode:
   - compute dedup decisions, log counters, do not suppress yet
3. Enforce mode:
   - suppress duplicate verbose payloads on dedup hit
4. Validate:
   - token deltas + no diagnostics loss
5. Default on after one stable cycle

## Metrics to Track

- `hook.events.total`
- `hook.dedup.hit`
- `hook.dedup.miss`
- `hook.output.pointer`
- `hook.output.fallback`
- `hook.output.verbose` (should trend down)

## Acceptance Criteria

- Hook commands produce valid JSON output under Claude hook contract.
- No duplicated verbose diagnostics when corresponding MCP output exists in TTL window.
- Fallback summaries still provide actionable signal when MCP output is absent.
- Dedup state survives parallel hook execution safely.
- Package builds/tests/typechecks/lints under existing monorepo scripts.

## Open Questions

1. Should `updatedMCPToolOutput` be used in first release, or only pointer/suppress mode?
2. Is 45s TTL enough under slow CI/inference environments, or should it be 60-90s?
3. Should dedup key include `tool_use_id` when available for narrower pairing?

