---
status: pending
priority: p3
issue_id: "019"
tags: [code-review, quality, documentation]
dependencies: []
---

# Fix stale JSDoc reference to "mcpez" in parse-utils.ts

## Problem Statement

`packages/bun-runner/mcp/parse-utils.ts` line 5 has a stale comment: "Extracted to a separate file to allow testing without importing mcpez". The `mcpez` package no longer exists after the SDK migration.

## Findings

1. **Architecture strategist:** Identified stale reference, recommends updating to reference current architecture.

## Proposed Solutions

### Option A: Update comment (Recommended)

Change to: "Extracted to a separate file for independent unit testing without MCP SDK imports."

- **Effort:** Trivial
- **Risk:** None

## Technical Details

**Affected files:**
- `packages/bun-runner/mcp/parse-utils.ts` line 5

## Acceptance Criteria

- [ ] No references to "mcpez" remain in codebase

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Architecture strategist found |
