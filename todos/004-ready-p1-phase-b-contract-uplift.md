---
status: ready
priority: p1
issue_id: "004"
tags: [mcp, tsc-runner, prompt-engineering, outputSchema, contract]
dependencies: ["002", "003"]
---

# Phase B: tsc-runner Contract Uplift

## Problem Statement

`tsc_check` needs its tool contract updated with the artifacts produced in Phase 0b. This includes description, title, outputSchema, annotations, TS error code extraction, compact JSON, em dash fix, and version sync.

## Findings

Current issues (from GitHub):
- Issue #28: description too terse for LLM routing
- Issue #29: em dash in error output (`-- ${error.message}`)
- Issue #30: `JSON.stringify(data, null, 2)` wastes ~30% tokens
- Issue #31: regex discards TS error codes (e.g. `TS2345`)
- Server version hardcoded `1.0.0` vs package.json `1.0.2`

## Proposed Solutions

### Option 1: Apply Phase 0b artifacts directly

**Approach:** Copy-paste the approved descriptions, schemas, titles, and annotations from the Phase 0b research doc. Add TS error code capture to regex. Switch to compact JSON. Fix em dash and version.

**Effort:** 2-3 hours

**Risk:** Low (metadata-only changes + regex update)

## Recommended Action

To be filled during triage.

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts` -- tool registration, regex, JSON formatting

**Changes:**
1. Update `description` from Phase 0b artifact
2. Add `title` from Phase 0b artifact
3. Add `outputSchema` from Phase 0b artifact
4. Update annotations from Phase 0b artifact
5. Update error regex to capture TS error codes: `/^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm`
6. Replace `JSON.stringify(data, null, 2)` with `JSON.stringify(data)`
7. Replace em dash with `--`
8. Sync server version with package.json

## Resources

- GitHub Issues: #28, #29, #30, #31
- Phase 0b contract artifact (once produced)

## Acceptance Criteria

- [ ] Description follows what/when/returns/boundaries from Phase 0b
- [ ] `title` set per Phase 0b artifact
- [ ] `outputSchema` validates against actual response shape
- [ ] Annotations correct (`readOnlyHint: true`, `idempotentHint: true`)
- [ ] TS error codes captured in parsed output (e.g. `TS2345`)
- [ ] JSON output compact (no pretty-print whitespace)
- [ ] No em dashes in output
- [ ] Server version matches package.json
- [ ] Contract tests pass, response validates against `outputSchema` at 100%

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created todo from brainstorm Phase B
- Depends on Phase 0b (issue 002) for artifacts and Phase A (issue 003) for SDK
