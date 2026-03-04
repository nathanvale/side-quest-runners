---
status: ready
priority: p1
issue_id: "002"
tags: [mcp, prompt-engineering, descriptions, outputSchema, annotations, discoverability]
dependencies: []
---

# Phase 0b: Cross-Runner Contract Artifacts -- prompt engineering for tool discoverability

## Problem Statement

All 7 tools across 3 runners have minimal descriptions that don't follow MCP best practices for LLM routing. None have `title` or `outputSchema`. Annotations are incomplete (only `biome_lintFix` sets `destructiveHint`). Claude picks tools based on descriptions, not names -- getting this wrong means tools don't get used.

Research confirms tool description quality is the #1 factor in reliable tool routing. We need copy-paste-ready artifacts before implementation.

## Findings

- Current `tsc_check` description: `"Run TypeScript type checking (tsc --noEmit) using the nearest tsconfig/jsconfig."` -- too terse, no boundaries
- No tools have `title` (MCP 2025-06-18 spec)
- No tools have `outputSchema` (MCP 2025-06-18 spec)
- Only `biome_lintFix` sets `destructiveHint: true`; other tools lack `idempotentHint`
- Best practice: descriptions should follow what/when/returns/boundaries pattern
- Descriptions must pass the "new hire" test
- Token budget: under 200 tokens per description

**Tools to cover (7 total):**
1. `tsc_check` (tsc-runner) -- type checking
2. `bun_runTests` (bun-runner) -- run all tests
3. `bun_testFile` (bun-runner) -- run tests for specific file
4. `bun_testCoverage` (bun-runner) -- test coverage report
5. `biome_lintCheck` (biome-runner) -- lint check (read-only)
6. `biome_lintFix` (biome-runner) -- lint fix (destructive)
7. `biome_formatCheck` (biome-runner) -- format check (read-only)

## Proposed Solutions

### Option 1: Research doc with draft artifacts

**Approach:** Produce a research doc at `docs/research/` containing draft descriptions, `outputSchema` definitions, `title` values, and annotation audits for all 7 tools. Review and approve before Phase B implementation.

**Pros:**
- Artifacts are reviewable before code changes
- Single source of truth for all tool contracts
- Can be done in parallel with Phase 0

**Cons:**
- Adds a document to maintain

**Effort:** 2-3 hours

**Risk:** Low

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files (for reference during drafting):**
- `packages/tsc-runner/mcp/index.ts` -- `tsc_check` tool registration
- `packages/bun-runner/mcp/index.ts` -- 3 tool registrations
- `packages/biome-runner/mcp/index.ts` -- 3 tool registrations

**Description pattern (what/when/returns/boundaries):**
```
WHAT: Check TypeScript files for type errors using tsc --noEmit.
WHEN: Use after editing .ts/.tsx files to verify type safety.
RETURNS: Structured JSON with file, line, col, code, and message for each error.
BOUNDARIES: Read-only. Does NOT fix errors -- only reports them. Does NOT run tests.
```

**Cross-tool disambiguation needed:**
- `bun_runTests` vs `bun_testFile` -- all tests vs specific file
- `biome_lintCheck` vs `biome_lintFix` -- report only vs auto-fix
- `biome_lintCheck` vs `biome_formatCheck` -- linting vs formatting

## Resources

- [MCP best practices research](/Users/nathanvale/code/side-quest-marketplace/docs/research/2026-03-03-mcp-best-practices-prompt-engineering.md)
- [MCP Tools spec (2025-06-18)](https://modelcontextprotocol.io/docs/concepts/tools) -- `title`, `outputSchema`
- [Brainstorm doc](/Users/nathanvale/code/side-quest-runners/docs/brainstorms/2026-03-04-tsc-runner-uplift.md)

## Acceptance Criteria

- [ ] Draft descriptions for all 7 tools following what/when/returns/boundaries
- [ ] `title` defined for all 7 tools
- [ ] `outputSchema` JSON structure defined for all 7 tools
- [ ] Annotations audited and corrected (`readOnlyHint`, `destructiveHint`, `idempotentHint`) for all 7
- [ ] Each description validated under 200-token budget
- [ ] Cross-tool disambiguation reviewed -- no overlap or ambiguity
- [ ] Research doc published and approved

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase 0b

**Learnings:**
- Runs in parallel with Phase 0 (no dependency on architecture decision)
- Output feeds directly into Phase B implementation
