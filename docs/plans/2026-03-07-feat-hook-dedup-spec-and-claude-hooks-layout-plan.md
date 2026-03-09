---
title: Hook Dedup Spec + `claude-hooks` Package Layout
date: 2026-03-07
status: ready
owner: nathanvale
tags: [hooks, token-efficiency, claude-code, mcp, architecture, dedup]
deepened: 2026-03-07
---

# Hook Dedup Spec + `claude-hooks` Package Layout

## Enhancement Summary

**Deepened on:** 2026-03-07
**Agents used:** 14 (architecture, security, performance, simplicity, TypeScript, pattern-recognition, CLI-reliability, agent-native, best-practices-researcher, framework-docs-researcher, learnings-researcher, repo-research, reliability-guardrails, naming-conventions)

### Key Improvements

1. **Use `tool_use_id` as primary correlation key** - eliminates time-bucket boundary problem and race conditions entirely
2. **Flatten package layout** - use `hooks/` source root with co-located tests to match monorepo conventions
3. **Add stdout safety boundary** - mandatory `writeFailsafeJson()` catch-all in every CLI entry point
4. **Correct `suppressOutput` misunderstanding** - it only hides from verbose UI, NOT from Claude's context
5. **Simplify DedupState** - reduce from 8 fields to 4; use discriminated union for decision results
6. **Add cache directory security** - TMPDIR ownership verification, `0o700` dirs, `0o600` files
7. **Single CLI binary** - one `sq-claude-hook` with subcommands, not four separate bins
8. **Add dedup metadata to pointer output** - agent must know dedup occurred (~50 tokens)
9. **Never suppress `PostToolUseFailure`** against success-path MCP results
10. **Drop bucket from dedup key** - use TTL-based validity instead; bucket only for write-coalescing

### Open Questions Resolved

1. **`updatedMCPToolOutput`** - Defer to v2. Start with pointer mode. Using it requires reconstructing MCP output format and carries silent-corruption risk if validation fails.
2. **TTL** - Increase to 60s default. 45s is tight for slow test suites. Make configurable via `SQ_HOOK_EVENT_TTL_MS` env var. Consider 90s for CI (`TF_BUILD=true`).
3. **`tool_use_id`** - Yes, use it as primary correlation key. It is confirmed available on PreToolUse, PostToolUse, and PostToolUseFailure events. Fall back to operation+target key when absent (future platform compatibility).

### New Risks Discovered

- **`suppressOutput: true` does not prevent context injection** - only hides from verbose UI
- **`Bun.write()` is NOT atomic** - must use `writeFileSync` + `renameSync` pattern
- **TMPDIR symlink attack** (HIGH) - shared CI environments could hijack cache directory
- **Unbounded stdin parsing** - could OOM the hook process without a size cap

---

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
- Matching hooks run in parallel; identical commands are deduplicated by Claude Code (by command string for command hooks, by URL for HTTP hooks).
- Async hooks (`"async": true`) cannot block/control decisions.
- `PostToolUse` supports `updatedMCPToolOutput` for MCP tools (replaces tool output with provided value).
- `PreToolUse` top-level `decision/reason` is deprecated for this event; use:
  - `hookSpecificOutput.permissionDecision`
  - `hookSpecificOutput.permissionDecisionReason`

### Research Insights: Hook stdin/stdout contract (verified 2026-03-07)

**Common stdin fields (all events):**
- `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`
- Subagent context: `agent_id`, `agent_type`

**PostToolUse-specific stdin fields:**
- `tool_name` - e.g. `"mcp__bun-runner__bun_runTests"`
- `tool_input` - arguments sent to the tool
- `tool_response` - the result the tool returned
- `tool_use_id` - e.g. `"toolu_01ABC123..."` (confirmed available)

**PreToolUse stdin fields:**
- `tool_name`, `tool_input`, `tool_use_id` (no `tool_response` - tool hasn't run yet)

**Stdout output fields Claude parses (exit 0 only):**
- `continue` (default `true`) - if `false`, stops processing entirely
- `stopReason` - shown to user when `continue` is false (NOT shown to Claude)
- `suppressOutput` (default `false`) - **ONLY hides from verbose UI, does NOT suppress from Claude's context**
- `systemMessage` - warning shown to user
- `hookSpecificOutput` (requires `hookEventName` field):
  - `additionalContext` - string injected into Claude's context window
  - `updatedMCPToolOutput` - for MCP tools only, replaces tool output

**Exit code behavior:**
- Exit 0: stdout JSON parsed by Claude
- Exit 2: blocking error - stderr fed to Claude as error message (PostToolUse: "Shows stderr to Claude since tool already ran")
- Other non-zero: non-blocking - stderr shown in verbose mode only, execution continues

**Critical correction:** `suppressOutput: true` does NOT prevent `additionalContext` or `decision`/`reason` from reaching Claude. To avoid duplicate context, simply omit those fields from the JSON output.

Sources:
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Legacy docs alias: https://docs.anthropic.com/en/docs/claude-code/hooks

### MCP constraints we must preserve

- `structuredContent` is the machine contract and should remain valid JSON per output schema.
- `content` text can be optimized independently.
- Claude Code reads only `content[].text`, not `structuredContent` directly.

### Research Insights: MCP output schema constraints

From the cross-runner contract research (`docs/research/2026-03-04-cross-runner-contract-artifacts.md`):

- Never use `z.optional()` or `z.union()` in outputSchema (TypeScript SDK issue #1308) - only bare `z.object()`
- Always return BOTH `content` and `structuredContent` for backwards compatibility
- `isError: true` validates against outputSchema BEFORE checking error flag (issue #654)
- Use camelCase for all output fields (matches existing runner conventions: `errorCount`, not `error_count`)

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
- Dedup logic and policy should live in platform-neutral modules inside the package, with no direct dependency on Claude hook JSON in core APIs.
- Future adapters (for other agent platforms) can reuse the same core modules and persistence format.

### Research Insights: Architecture

**Adapter pattern assessment:** The core/adapter split is structurally sound and follows Dependency Inversion correctly: core defines the `DedupIntent` contract, adapters implement it. However, given only one platform exists today, keep the adapter layer minimal -- inline if it's just 2-3 functions. Extract to a directory only when a second platform actually arrives.

**Key architectural invariant:** The hooks package must have ZERO workspace dependencies on runner packages. The dependency flows one way: hooks know runner semantics through its own type definitions (runner kind enum, operation enum), not through imports from `@side-quest/bun-runner` etc. The runners are consumed via MCP; the hooks package uses string-based tool name contracts.

**Factory function for testability:** Even though this is not an MCP server, adopt the factory function pattern for testability: `createHookHandler(options)` where options allow injecting mock stores, clocks, and file systems. This enables the same three-tier test strategy (unit, integration, smoke) used by the runners.

**Logging:** Adopt `@logtape/logtape` with `fingersCrossed` handler, consistent with all three existing runner packages. Namespace under `side-quest.hooks.*` categories. Critical: LogTape must NEVER write to stdout - stderr only.

## Dedup Specification (Contract + Keying + TTL)

### Scope

- Initial scope: dedup runner-related signals for:
  - `biome` checks/fixes
  - `bun` test checks
  - `tsc` checks
- Events handled:
  - `PostToolUse` and `PostToolUseFailure`
  - `PreToolUse` only for key pre-registration when useful

### Canonical Signal Ownership

- MCP runner output remains canonical diagnostics source.
- Hook output should be one of:
  1. `pointer` (short instruction to check MCP tool result, with dedup metadata)
  2. `fallback-summary` (compact details only if no MCP result arrives within TTL window)
- Never fully suppress output. Always emit at minimum a pointer with dedup metadata (~50 tokens). The agent must always know that a hook ran and whether dedup occurred.

### Research Insights: Agent-Native Output Design

**Always include dedup metadata in pointer output.** Without it, the agent cannot distinguish "nothing happened in the hook" from "something happened but was deduplicated." Minimum fields:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Dedup: MCP result already received for bun/runTests. See MCP tool output above."
  }
}
```

**Never suppress `PostToolUseFailure` against a success-path MCP result.** If the MCP call succeeded but the hook fires `PostToolUseFailure`, that divergence is critical diagnostic signal. Add `mcpWasError: boolean` tracking and only dedup when both are on the same success/failure path.

**Fallback summary must match existing compact format.** Define schema explicitly -- at minimum: pass/fail status, error count, file count, and first N diagnostics (e.g., 5). Reference the existing `compactSummaryForJsonText` and `compactLintSummaryForJsonText` patterns.

### Dedup Key

Key fields (normalized):

- `runnerKind`: one of `biome`, `bun`, `tsc`
- `operation`: e.g. `lintCheck`, `lintFix`, `formatCheck`, `runTests`, `testFile`, `testCoverage`, `typecheck`
- `toolUseId`: from Claude hook stdin (primary correlation key when available)
- `target`: normalized path/file or normalized selector (fallback key component when `toolUseId` absent)
- `projectRoot`: realpath of repo root (for cache partitioning, not in key string)

String format (when `toolUseId` available - preferred):

```text
<runnerKind>|<operation>|<toolUseId>
```

Fallback format (when `toolUseId` absent - future platform compat):

```text
<runnerKind>|<operation>|<target>
```

Hash form:

- `sha256(keyString)` as stable key id (filename-safe)

### Research Insights: Dedup Key Design

**`tool_use_id` eliminates the time-bucket boundary problem.** Two events 50ms apart straddling a 10-second boundary would have different bucket-based keys, causing a false-negative. With `tool_use_id`, the MCP call and hook event share the exact same ID -- correlation is exact, not heuristic.

**Drop bucket from key entirely.** Use TTL-based validity on the record instead:
- When looking up a key, check `now - record.createdAtMs < eventTtlMs`
- Bucket can optionally be used as a write-coalescing check (skip write if record is recent)

**Use branded types for keys:**

```ts
type DedupKey = string & { readonly __brand: unique symbol }
```

A single `buildDedupKey(parts: DedupKeyParts): DedupKey` factory becomes the only way to create one.

**`operation` should be a strict union type, not `string`:**

```ts
type RunnerOperation =
  | 'lintCheck' | 'lintFix' | 'formatCheck'
  | 'runTests' | 'testFile' | 'testCoverage'
  | 'typecheck'
```

### TTL + Storage

- `eventTtlMs`: 60_000 (default; configurable via `SQ_HOOK_EVENT_TTL_MS`)
  - Consider 90_000 for CI (`TF_BUILD=true`) where operations are slower
- storage:
  - file-backed JSON cache under `${TMPDIR}/side-quest-hooks-cache/<repo-hash>.json`
  - ~200-300KB at capacity; Bun parses this in <2ms

### Research Insights: Storage & Performance

**Single JSON file is correct at this scale.** At ~2000 entries, the full read-parse-write cycle is fast enough. The simplicity dividend (debuggable with `cat`, no format migration) outweighs marginal gains from per-key files or SQLite.

**Remove the in-process memory mirror concept.** Each hook invocation is a fresh process, so the mirror is populated from disk every call and never reused. It provides zero benefit. The parsed JSON object from `JSON.parse()` already serves as the in-memory representation.

**Latency budget per invocation (estimated):**

| Phase | Cost |
|-------|------|
| Process startup (compiled Bun) | 15-25ms |
| stdin JSON parse | < 1ms |
| SHA-256 key computation | < 0.01ms |
| Cache file read + parse | 1-5ms |
| Decision logic | < 0.1ms |
| Cache write (atomic rename) | 1-5ms |
| stdout JSON write | < 0.5ms |
| **Total** | **~20-35ms** |

This adds <1% overhead to MCP tool calls that take 500ms-30s.

**Pruning strategy:** TTL-based lazy eviction on write. On each write cycle: (1) filter out expired entries, (2) if remaining > `maxEntries`, sort by `createdAtMs` ascending and trim. No LRU needed - entries are written once/twice then expire.

**SQLite as documented escape hatch:** If JSON + atomic rename proves insufficient, `bun:sqlite` with WAL mode is a zero-dependency alternative. Design `dedup-store` interface to allow swap as a single-file change.

### Record Shape

```ts
type DedupRecord = {
  createdAtMs: number
  hookSeen: boolean
  mcpSeen: boolean
  mcpWasError: boolean
}
```

### Research Insights: Record Shape

**Simplified from 8 fields to 4.** The original `lastUpdatedAtMs`, `lastHookEvent`, `runnerKind`, `operation`, and `target` fields are either unused by the decision algorithm or derivable from the key. With `tool_use_id` as the primary key, the record only needs to track timing and seen-state.

**Decision result as discriminated union:**

```ts
type DedupDecision =
  | { action: 'pointer'; message: string; dedupKey: string; mcpSeenAtMs: number }
  | { action: 'fallback'; summary: FallbackSummary }
```

No `suppress` action -- always emit at least a pointer.

### Decision Algorithm

For each qualifying hook event:

1. Read `tool_use_id`, `tool_name`, and `tool_response` from stdin.
2. Infer `runnerKind` and `operation` from `tool_name`.
3. Compute dedup key (prefer `tool_use_id`, fall back to operation+target).
4. Read dedup record from cache.
5. **If `PostToolUseFailure` event and existing record shows `mcpSeen === true` and `mcpWasError === false`:**
   - Do NOT dedup. Emit full fallback summary. Error/success divergence is critical signal.
6. **If `mcpSeen === true` and record age <= `eventTtlMs`:**
   - Emit pointer with dedup metadata (action, key, timestamp).
7. **Else:**
   - Emit compact fallback summary (pass/fail, error count, file count, first 5 diagnostics).
8. Mark `hookSeen = true` in cache record.
9. If `tool_response` present in stdin (PostToolUse), set `mcpSeen = true` and `mcpWasError` based on response.

### Minimal Hook Output Policy

- Default for dedup hit:
  - JSON output with `hookSpecificOutput.additionalContext` containing pointer + dedup metadata.
  - Do NOT use `suppressOutput: true` to prevent context injection -- it only affects verbose UI.
  - To avoid duplicate context, simply omit verbose details from `additionalContext`.
- Never print full duplicated diagnostics JSON from hook once a matching MCP result exists.
- Always emit at minimum a pointer (~50 tokens) -- never fully silent.

### Research Insights: Output Decision Table

| Scenario | `additionalContext` | `suppressOutput` | Notes |
|----------|-------------------|------------------|-------|
| Dedup hit (MCP result exists) | Short pointer + dedup metadata | `false` | Agent knows dedup occurred |
| Dedup miss (no MCP result yet) | Compact fallback summary | `false` | Agent gets actionable signal |
| PostToolUseFailure with success MCP | Full failure details | `false` | Never suppress error divergence |
| Shadow mode | Empty string | `false` | Minimal valid envelope |

### Failure Modes & Mitigations

1. **False-positive dedup (suppressed unrelated event)**
   - Mitigation: `tool_use_id` as primary key eliminates most false positives. Fallback target normalization + operation-specific keying for platforms without `tool_use_id`.

2. **False-negative dedup (duplicate still emitted)**
   - Mitigation: acceptable safety failure; tune key canonicalization and TTL.

3. **Cache corruption / unreadable file**
   - Mitigation: fail open (emit compact fallback summary), rebuild cache atomically. Verify file ownership via `lstatSync` before reading.

4. **Race conditions across parallel hooks**
   - Mitigation: atomic write (`writeFileSync` to temp + `renameSync`), last-write-wins. Lost updates are safe because dedup cache is additive and idempotent. Temp files use PID + random suffix. Always unlink temp file on write failure.
   - Note: `Bun.write()` is NOT atomic -- must use Node.js `fs` APIs.

5. **Claude JSON parse breakage due to noisy stdout**
   - Mitigation: mandatory `writeFailsafeJson()` top-level catch in every CLI entry point. Only `shared-io.ts` may write to `process.stdout`. Consider wrapping `console.log` to throw in production mode.

6. **Contract drift in Claude hooks**
   - Mitigation: schema fixtures + CI contract tests pinned to current docs behavior. Zod `.passthrough()` on input for forward compatibility, `.strip()` before passing to core.

7. **TMPDIR symlink attack (NEW - HIGH)**
   - Mitigation: validate TMPDIR ownership (`lstatSync`, verify uid matches `process.getuid()`). Create cache directory with `mode: 0o700`. Reject symlinks. Set cache files to `0o600`.

8. **Unbounded stdin parsing (NEW - MEDIUM)**
   - Mitigation: cap stdin reads at `HOOK_STDIN_MAX_BYTES` (4MB). Fail open with fallback summary if exceeded.

9. **`updatedMCPToolOutput` silent corruption (NEW - HIGH)**
   - Mitigation: never set `updatedMCPToolOutput` in fallback-summary path. Only set when `mcpSeen === true` AND cached content passes Zod validation against runner output schema. Omit field entirely (not `null` or `{}`) when validation fails. Defer to v2.

10. **ENOSPC / EPERM on cache write (NEW)**
    - Mitigation: trigger fail-open path (emit compact fallback, skip cache update). Always unlink partial temp files.

### Research Insights: Security

**Cache directory security checklist:**
- Create `${TMPDIR}/side-quest-hooks-cache/` with `mkdirSync(path, { mode: 0o700 })`
- Verify it is not a symlink via `lstatSync` before using
- Set cache files to `0o600`
- Use `os.tmpdir()` with ownership checks as fallback
- On CI, TMPDIR may be shared -- consider `${os.tmpdir()}/side-quest-hooks-cache-${process.getuid()}`

**Stdout safety (non-negotiable):**
- Every CLI entry point wraps its entire body in `try/catch`
- Catch block calls `writeFailsafeJson()` that writes minimal valid `{ "hookSpecificOutput": {} }` to stdout
- Error details go to stderr only
- Exit code is always `0` unless intentionally denying PreToolUse permission

**Input validation:**
- Parse stdin with Zod `.passthrough()` for forward compatibility
- Strip unknown fields before passing to core
- Validate `target` against character allowlist (alphanumeric, `/`, `.`, `-`, `_`)
- Apply `realpath` normalization at input boundary, not deferred to key computation

## `packages/claude-hooks` Exact Layout

```text
packages/claude-hooks/
+-- CHANGELOG.md
+-- LICENSE
+-- README.md
+-- bunup.config.ts
+-- package.json
+-- tsconfig.json
+-- hooks/
|   +-- index.ts              # exports + CLI command router + entry guard
|   +-- index.test.ts         # integration tests (co-located)
|   +-- pretool.ts            # PreToolUse handler
|   +-- posttool.ts           # PostToolUse handler
|   +-- posttool-failure.ts   # PostToolUseFailure handler
|   +-- stdio.ts              # stdin parse / stdout JSON helpers / writeFailsafeJson
|   +-- dedup-key.ts          # key computation + branded type
|   +-- dedup-key.test.ts     # co-located unit tests
|   +-- dedup-store.ts        # cache read/write with atomic rename
|   +-- dedup-store.test.ts   # co-located unit tests
|   +-- dedup-policy.ts       # decision algorithm
|   +-- dedup-policy.test.ts  # co-located unit tests
|   +-- claude-schema.ts      # Claude event input/output Zod schemas
|   +-- claude-schema.test.ts # co-located schema tests (incl. deprecated field rejection)
|   +-- claude-mapper.ts      # map Claude event -> core DedupIntent
|   +-- claude-response.ts    # produce hookSpecificOutput safely
|   +-- runner-mapping.ts     # infer runnerKind + operation from tool name
|   +-- types.ts              # shared types (DedupRecord, DedupDecision, DedupKey, etc.)
```

### Research Insights: Layout Changes

**Use `hooks/` as source root instead of `src/`.** The existing packages use `mcp/` as source root, not `src/`. Using `hooks/` follows the same naming pattern (source root named after package purpose) and matches the repo's mental model.

**Co-locate tests beside source.** All existing packages co-locate tests (`mcp/index.test.ts` beside `mcp/index.ts`). A separate `test/` directory would need different tsconfig handling and breaks the established pattern.

**Flatten the directory structure.** The original 4-level nesting (`src/adapters/claude/`, `src/core/`, `src/integrations/runners/`) is over-engineered for ~15 source files. Use naming prefixes instead (`claude-*`, `dedup-*`). If it grows past 20 files, subdirectories become justified.

**Removed `mcp/` directory.** The original plan listed `mcp/` as "optional helper integration tests/fixtures only." This conflicts with the repo convention where `mcp/` means "this is the MCP server." Removed to avoid confusion.

**Added missing test file:** `posttool-failure.test.ts` was absent from the original layout. `PostToolUseFailure` has a distinct input shape and different response semantics (never suppress against success-path MCP).

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
    "sq-claude-hook": "./dist/index.js"
  }
}
```

CLI style (single binary with subcommands):

```bash
sq-claude-hook pretool
sq-claude-hook posttool
sq-claude-hook posttool-failure
```

### Research Insights: Packaging

**Single bin entry matches monorepo convention.** Existing packages each have one bin entry. The four separate binaries (`sq-claude-hook-pretool`, etc.) are redundant with the subcommand router and add build complexity (multi-entry bunup config).

**bunup.config.ts:**

```ts
import { defineConfig } from 'bunup'

export default defineConfig({
  entry: './hooks/index.ts',
  outDir: './dist',
  format: 'esm',
  dts: true,
  clean: true,
  splitting: false,
  target: 'bun',  // Critical: preserves import.meta.main and Bun-specific APIs
})
```

**tsconfig.json:**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {},
  "include": ["hooks/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

**Dependencies:** `@logtape/logtape`, `zod`. No `@modelcontextprotocol/sdk` needed (not an MCP server).

**Root tsconfig.json** needs updating to include `packages/*/hooks/**/*.ts` alongside existing `packages/*/mcp/**/*.ts`.

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

- Core dedup logic (key computation, store, policy) contains no Claude-specific shapes.
- Claude-specific code (`claude-schema.ts`, `claude-mapper.ts`, `claude-response.ts`) is isolated by naming convention.
- Future adapters can map platform events into the same `DedupIntent` contract.
- If a platform has no hooks (Codex today), core logic is still reusable in wrapper CLI flows or middleware.
- `tool_use_id`-based keying gracefully degrades to operation+target keying for platforms that don't provide the ID.

### Non-Lock-In Rules (Must Hold)

1. `hooks/dedup-*.ts` and `hooks/types.ts` must not import `claude-*` modules.
2. `claude-*` modules can depend on core, never the reverse.
3. `runner-mapping.ts` may know runner tool names, but must not import runner packages.
4. Add a CI assertion (simple `rg` guard) to fail if core imports `claude-*`.

## Migration Plan: Marketplace Hooks -> `@side-quest/claude-hooks`

1. Keep existing marketplace hooks active initially (no behavior change).
2. Add `@side-quest/claude-hooks` commands in parallel behind `SQ_HOOK_DEDUP_ENABLED=0`.
3. Compare one week of logs:
   - pointer/fallback ratios
   - dedup hit/miss
   - token delta on representative workflows
4. Flip marketplace hook commands to `sq-claude-hook ...` with flag enabled.
5. Remove old duplicated payload logic from marketplace plugin after stable window.

Rollback:
- Re-point marketplace hook commands to previous scripts.
- Keep package installed; set `SQ_HOOK_DEDUP_ENABLED=0`.

## Rollout Plan

1. **Feature flag off (default):**
   - `SQ_HOOK_DEDUP_ENABLED=0|1` (default `0`)
   - Hook installed but disabled; emits minimal `{}` envelope and exits
2. **Feature flag on:**
   - Compute dedup decisions, emit pointer or fallback summary
   - Log dedup counters to LogTape stderr sink (`['side-quest', 'hooks', 'metrics']`)
3. **Validate:**
   - Token deltas + no diagnostics loss
   - Run A/B evaluation with live model routing (reference `scripts/discoverability/eval-ab.ts` methodology)
4. **Default on** after one stable cycle

### Research Insights: Rollout

**Skip shadow mode.** The failure mode for bad dedup is "emit slightly more text than needed" -- the same thing that happens today without the feature. This is not a payment system. Two states (off/on) are sufficient.

**A/B evaluation is mandatory before shipping.** From the existing discoverability benchmark learnings: token counts alone do not prove correctness. Create `scripts/hooks/eval-dedup.ts` harness, test on core (10 regression) + stress (22 ambiguous) suites, gate on first-choice accuracy regression <= 2%.

**Token measurement:** Use `estimated_tokens = ceil(character_count / 4)` as stable approximation, consistent with the existing measurement methodology.

## Metrics to Track

All metrics emitted as structured LogTape entries to stderr only (never stdout). Logger category: `['side-quest', 'hooks', 'metrics']`.

- `hook.events.total`
- `hook.dedup.hit`
- `hook.dedup.miss`
- `hook.dedup.failureNotSuppressed` (PostToolUseFailure divergence)
- `hook.output.pointer`
- `hook.output.fallback`
- `hook.cache.writeError`
- `hook.latency.totalMs`

## Acceptance Criteria

- Hook commands produce valid JSON output under Claude hook contract.
- All CLI entry points have a top-level `writeFailsafeJson()` catch boundary -- no path produces invalid stdout.
- All CLI entry points exit `0` unless intentionally denying PreToolUse permission.
- No duplicated verbose diagnostics when corresponding MCP output exists in TTL window.
- `PostToolUseFailure` events are never suppressed against success-path MCP results.
- Fallback summaries provide actionable signal (pass/fail, error count, first 5 diagnostics).
- Pointer output always includes dedup metadata (~50 tokens).
- Dedup state survives parallel hook execution safely (atomic rename, last-write-wins).
- Cache directory created with `0o700`, files with `0o600`, symlinks rejected.
- Stdin reads capped at `HOOK_STDIN_MAX_BYTES` (4MB).
- Package builds/tests/typechecks/lints under existing monorepo scripts.
- Tests include stdout-isolation assertion (no non-JSON on stdout).
- Contract fixture tests pin Claude hook input schemas to known-good docs behavior.
- Startup latency target: < 150ms per invocation (process start to first stdout byte).

## Test Strategy

Three tiers matching existing monorepo pattern:

1. **Unit tests** (co-located `*.test.ts`):
   - `dedup-key.test.ts` - key generation, branded type, normalization edge cases
   - `dedup-store.test.ts` - cache read/write, atomic rename, corruption recovery, TTL eviction
   - `dedup-policy.test.ts` - decision algorithm, error/success path distinction, edge cases
   - `claude-schema.test.ts` - Zod validation, deprecated field rejection (top-level `decision` must fail), output schema compliance

2. **Integration tests** (`index.test.ts`):
   - `createHookHandler(options)` with mock deps, piping stdin/stdout
   - Stdout-isolation test: assert no non-JSON text on stdout during operation
   - Error boundary test: unhandled exception produces valid JSON on stdout
   - Corrupted cache test: malformed JSON triggers fail-open path

3. **Smoke tests** (add to `scripts/smoke/` or peer file):
   - Subprocess invocation of built binary
   - Pipe minimal valid Claude hook JSON to stdin
   - Assert: stdout is valid JSON, exit code is `0`, no non-JSON text on stdout

## Atomic Write Implementation Notes

```
// CORRECT - atomic on POSIX
writeFileSync(tempPath, data)  // temp in SAME directory as target
renameSync(tempPath, targetPath)

// WRONG - Bun.write() is NOT atomic
Bun.write(targetPath, data)  // concurrent readers see partial file
```

- Temp file name: `<target>.tmp.${process.pid}.${randomHex}`
- Must be same filesystem as target (same directory is safest)
- Use synchronous variants - async adds complexity with no benefit for a short-lived process
- Always unlink temp file in catch block on write failure
