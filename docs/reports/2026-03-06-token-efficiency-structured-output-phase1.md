# Token Efficiency Phase 1 Report (Structured Output + Text Compaction)

Date: 2026-03-06  
Scope: `bun-runner`, `biome-runner`, `tsc-runner` MCP response shaping

## What Changed

1. Null/undefined fields are stripped from structured tool payloads before returning `structuredContent`.
2. Shared file paths are deduplicated in JSON text output via `commonFile` + compact per-item entries.
3. Bun markdown output now truncates stack rendering to the top frame.
4. Markdown diagnostic summaries deduplicate shared file paths for biome/tsc error lists.

## Benchmark Method

- Payload shapes mirror the local spike profile in todo `023`:
  - Bun: 7 failures from one file
  - Biome: 11 diagnostics from one file with null suggestions
  - TSC: 8 errors from one file
- Comparison target: JSON text payload (`JSON.stringify(...)`) before vs after compaction.
- Token estimate: `ceil(chars / 4)` (stable approximation used for relative comparison).

## Results

| Tool | Before chars | After chars | Char savings | Before tokens | After tokens | Token savings |
|---|---:|---:|---:|---:|---:|---:|
| bun | 972 | 371 | 61.83% | 243 | 93 | 61.73% |
| biome | 1840 | 918 | 50.11% | 460 | 230 | 50.00% |
| tsc | 1306 | 752 | 42.42% | 327 | 188 | 42.51% |

## Hook/MCP Overlap Audit

- Confirmed from existing investigation: hook output and MCP output can duplicate diagnostics in context.
- Hook scripts (`biome-ci`, `bun-test-ci`) are maintained in the marketplace plugin, not this repository.
- Action from this repo: documented overlap and retained as external dependency for Phase 1.5/2 implementation in marketplace hook layer.

## Validation Commands

```bash
bun test packages/bun-runner/mcp/index.test.ts
bun test packages/biome-runner/mcp/index.test.ts
bun test packages/tsc-runner/mcp/index.test.ts
bunx tsc --noEmit
```

## Rollback Plan

If compaction causes downstream issues:

1. Revert JSON text compaction helpers (`compact*ForJsonText`) first.
2. Keep null stripping only if client parsing remains stable.
3. If needed, revert null stripping in `createToolSuccess` / `structuredContent` path.

