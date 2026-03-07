---
status: complete
priority: p3
issue_id: "027"
tags: [code-review, workflow, quality, documentation]
dependencies: []
---

# Todo Status Contract Drift in Newly Added Review Files

## Problem Statement

Several newly added review todo files have status metadata that does not match the documented file-todos contract, and filenames still include `pending` while frontmatter indicates completion. This can break automation that depends on consistent status semantics.

## Findings

- `todos/023-pending-p2-token-efficiency-structured-responses.md` uses `status: completed` (not in documented enum `pending|ready|complete`).
- `todos/024-pending-p2-hook-metrics-buffered-and-not-emitted.md` uses `status: complete` while filename still contains `-pending-`.
- `todos/025-pending-p2-cli-entrypoint-failsafe-gap-on-parse-error.md` uses `status: complete` while filename still contains `-pending-`.
- The workflow instructions in this repo expect status transitions to be reflected in filename (`pending -> ready -> complete`).

## Proposed Solutions

### Option 1: Normalize statuses and rename files now

**Approach:** Update frontmatter status values to valid enum and rename completed files to `*-complete-*`.

**Pros:**
- Restores tooling consistency immediately
- Removes ambiguity for triage scripts

**Cons:**
- Minor git churn for rename operations

**Effort:** 30-45 minutes

**Risk:** Low

---

### Option 2: Keep filenames, enforce frontmatter-only status

**Approach:** Update docs/tooling to treat frontmatter as source of truth and ignore filename status token.

**Pros:**
- Avoids renames

**Cons:**
- Requires docs/tool changes
- Leaves legacy ambiguity in repository

**Effort:** 1-2 hours

**Risk:** Medium

## Recommended Action


## Technical Details

**Affected files:**
- [023-pending-p2-token-efficiency-structured-responses.md](/Users/nathanvale/code/side-quest-runners/todos/023-pending-p2-token-efficiency-structured-responses.md)
- [024-pending-p2-hook-metrics-buffered-and-not-emitted.md](/Users/nathanvale/code/side-quest-runners/todos/024-pending-p2-hook-metrics-buffered-and-not-emitted.md)
- [025-pending-p2-cli-entrypoint-failsafe-gap-on-parse-error.md](/Users/nathanvale/code/side-quest-runners/todos/025-pending-p2-cli-entrypoint-failsafe-gap-on-parse-error.md)

**Related components:**
- File-todos workflow
- Review/triage automation

**Database changes (if any):**
- No

## Resources

- Template: `/Users/nathanvale/.codex/skills/file-todos/assets/todo-template.md`
- Workflow docs in `AGENTS.md`

## Acceptance Criteria

- [x] Status values are only `pending`, `ready`, or `complete`
- [x] Filename status token matches frontmatter status
- [x] `ls todos/*-pending-*.md` returns only truly pending work

## Work Log

### 2026-03-07 - Initial Discovery

**By:** Codex

**Actions:**
- Audited new todo files added in this branch
- Compared filename conventions with frontmatter and documented workflow contract
- Captured mismatch set and remediation options

**Learnings:**
- Inconsistent status sources create drift that is easy to miss during manual review but painful for automated triage

## Notes

- This is a workflow-integrity issue (P3), not a product/runtime behavior defect.

### 2026-03-07 - Resolved

**By:** Claude Code

**Actions:**
- Fixed `status: completed` to `status: complete` in todo 023
- Renamed 17 todo files via `git mv` to align filename status tokens with frontmatter
- Verified: `*-pending-*` returns only truly pending, `*-ready-*` returns only truly ready

**Learnings:**
- Filename status tokens should be updated whenever frontmatter status changes
