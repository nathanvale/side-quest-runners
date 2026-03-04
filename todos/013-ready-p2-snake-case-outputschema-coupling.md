---
status: ready
priority: p2
issue_id: "013"
tags: [code-review, biome-runner, naming]
dependencies: []
---

# Snake Case outputSchema Coupling Risk in biome-runner

## Problem Statement

biome-runner's `LintSummary` type uses snake_case field names (`error_count`, `warning_count`, `unformatted_files`). These field names will propagate directly into the `outputSchema` definitions when added during Phase A, becoming the agent-facing contract.

The plan's "fix-while-migrating" section (line 422) lists `biome-runner error_count/warning_count snake_case -- normalize to camelCase` as a cleanup item. However, the plan also says `outputSchema` addition is a Phase A deliverable (line 412). If both happen in the same phase without explicit ordering, there are two compound risks:

1. **Schema churn** -- outputSchema is added with snake_case, then immediately changed to camelCase in the same phase. Any agent consuming the schema sees a breaking change.
2. **Incomplete normalization** -- camelCase normalization is partially applied, leaving some fields snake_case and others camelCase in the same schema.

The plan says "fix while migrating" but doesn't specify whether normalization must happen before, during, or after outputSchema addition.

## Findings

1. `LintSummary` in biome-runner uses `error_count`, `warning_count`, `info_count` -- snake_case.
2. `unformatted_files` in `biome_formatCheck` is also snake_case.
3. tsc-runner and bun-runner use camelCase (`errorCount`, `testCount`, etc.).
4. The project convention (per CLAUDE.md) is camelCase for functions and types.
5. outputSchema becomes the agent-facing contract -- field names are visible in `tools/list` responses and used by agents for structured consumption.
6. Changing field names after outputSchema is published is a breaking change for agent consumers.

## Proposed Solutions

### Solution 1: Make snake_case normalization an explicit Phase A pre-requisite

Normalize all biome-runner field names to camelCase before adding outputSchema. Enforce ordering: normalization PR merges first, then outputSchema PR.

- **Pros:** Clean contract from day one. No schema churn. Consistent naming across all 3 runners.
- **Cons:** Adds a dependency to Phase A sequencing. Normalization touches parser code and test assertions.
- **Effort:** Medium (3-4 hours for normalization + test updates, separate from outputSchema work)
- **Risk:** Low. The normalization is straightforward string replacement in parser output construction.

### Solution 2: Accept snake_case in outputSchema and normalize later

Add outputSchema with current snake_case field names. Defer normalization to a later phase.

- **Pros:** Simpler Phase A scope. No ordering dependency.
- **Cons:** Snake_case becomes the agent contract. Changing it later is a breaking change. Inconsistent naming across runners (biome uses snake_case, others use camelCase).
- **Effort:** Trivial (no extra work in Phase A)
- **Risk:** High. Once published, changing field names requires a deprecation cycle or version bump.

### Solution 3: Add a compatibility layer that maps both conventions

outputSchema uses camelCase, but the handler maps snake_case parser output to camelCase before returning `structuredContent`.

```typescript
const result = parseBiomeOutput(stdout)
const structured = {
  errorCount: result.error_count,
  warningCount: result.warning_count,
  // ...
}
return { content: [...], structuredContent: structured }
```

- **Pros:** outputSchema is clean from day one. Parser internals can be normalized at any time without affecting the contract.
- **Cons:** Mapping layer adds maintenance burden. Two naming conventions coexist in the codebase until parser is updated. Easy to forget a field.
- **Effort:** Small-medium (2-3 hours)
- **Risk:** Low-medium. Mapping layer is thin but must be kept in sync with parser changes.

## Technical Details

Current snake_case fields in biome-runner that would become part of outputSchema:

| Field | Current Name | Proposed camelCase |
|-------|-------------|-------------------|
| Error count | `error_count` | `errorCount` |
| Warning count | `warning_count` | `warningCount` |
| Info count | `info_count` | `infoCount` |
| Unformatted files | `unformatted_files` | `unformattedFiles` |

The SDK validates `structuredContent` against `outputSchema` at runtime. If the schema says `errorCount` but the handler returns `error_count`, the SDK throws a hard error. The field names must match exactly.

## Acceptance Criteria

- [ ] Decision documented in plan: normalization timing relative to outputSchema addition
- [ ] If normalizing: normalization happens before outputSchema is added (not simultaneously)
- [ ] All biome-runner outputSchema fields use consistent naming convention
- [ ] Naming convention is consistent across all 3 runners' outputSchemas

## Work Log

| Date | Note |
|------|------|
| 2026-03-04 | Code review finding documented |

## Resources

- Plan section: "fix-while-migrating items" (line 422) -- `biome-runner error_count/warning_count snake_case`
- Plan section: "Add `outputSchema` to all 7 tools" (Phase A deliverable, line 412)
- `packages/biome-runner/mcp/index.ts` -- biome-runner source (LintSummary type)
- Project convention: camelCase for functions and types (CLAUDE.md)
