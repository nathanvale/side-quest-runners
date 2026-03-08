---
status: complete
priority: p3
issue_id: "048"
tags: [code-review, compatibility, hooks, mapping]
dependencies: []
---

# Runner Mapping Is Brittle To Tool Name Drift

## Problem Statement

`inferRunnerMapping()` relies on exact string matches for tool names. Any naming drift (aliases, suffixes, server renames) silently disables dedup.

## Findings

- Location: `packages/claude-hooks/hooks/runner-mapping.ts`.
- Default path returns `null`, causing empty output behavior.
- No tests assert compatibility behavior for minor naming variations.

## Proposed Solutions

### Option 1: Add structured pattern matching with strict allowlist fallback (Recommended)
**Approach:** Parse `mcp__<server>__<tool>` format and map known tuples robustly.
**Pros:** Better forward resilience without over-broad matching.  
**Cons:** Slightly more parsing logic.  
**Effort:** Small  
**Risk:** Low

### Option 2: Keep exact matching but add explicit telemetry on unknown tool names
**Approach:** Emit metric for unmapped names to catch drift early.
**Pros:** Minimal behavior change.  
**Cons:** Still brittle by default.  
**Effort:** Small  
**Risk:** Low

## Recommended Action

## Technical Details
- Affected: `packages/claude-hooks/hooks/runner-mapping.ts`
- Add tests for unknown/variant tool names.

## Acceptance Criteria
- [ ] Mapping logic handles expected naming variation safely.
- [ ] Unknown mappings are observable via metrics.

## Work Log
### 2026-03-07 - Review capture
**By:** Codex  
**Actions:** Logged compatibility risk in mapping strategy.

