---
status: complete
priority: p1
issue_id: "008"
tags: [code-review, architecture, quality]
dependencies: []
---

# Plan Scope Creep -- Research Capture in Phase 0 Architecture Gate Plan

## Problem Statement

The Phase 0 plan (`docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md`) has ballooned to ~492 lines -- a 4.5x expansion from the original 108-line todo (001). It suffers from "research capture": findings from the deepening phase were absorbed into Phase 0 scope instead of being filed as Phase A inputs. Approximately 150 lines (30%) are removable implementation code blocks, Phase A checklists, and performance details that belong in downstream deliverables, not in a decision gate document.

Phase A deliverables embedded in Phase 0 acceptance criteria prevent Phase 0 from ever closing cleanly. The plan conflates "what we learned" with "what we must do now," making it harder to execute against and harder to declare done.

## Findings

1. **Line count:** ~492 lines vs the original todo's 108 lines (4.5x expansion)
2. **Implementation code blocks:** ~6 code blocks totaling ~80 lines (e.g., `withLogging` wrapper, `outputSchema` example, `responseFormatSchema` constants, server factory pattern, import paths) -- these are Phase A implementation details
3. **Phase A acceptance criteria in Phase 0:** Lines 401-427 list 18 Phase A and fix-while-migrating items as checkboxes inside the Phase 0 plan document
4. **Performance details:** Lines 337-345 discuss git root caching, JSON.stringify optimization, and startup heap improvements -- all Phase A/B execution concerns
5. **Community intelligence section:** Lines 481-486 are informational context that could live in a separate research notes file
6. **Agent-native design section:** Lines 263-303 define titles, outputSchemas, and description improvements for all 7 tools -- pure Phase A deliverables

## Proposed Solutions

### Option 1: Extract Phase A content to separate reference doc, trim plan to ~340 lines

**Approach:** Move all Phase A deliverables, implementation code blocks, and performance details to a new `docs/references/phase-0-research-findings.md` file. The plan retains the decision framework, PoC scope, rubric, and Phase 0-only acceptance criteria.

**Pros:**
- Plan becomes actionable and closable
- Research findings preserved and referenceable from Phase A todos
- Clear separation between "decide" (Phase 0) and "execute" (Phase A+)

**Cons:**
- Creates another file to maintain
- Risk of research findings becoming stale if not linked properly

**Effort:** Low (1-2 hours of editing)

**Risk:** Low

---

### Option 2: Move implementation code blocks to appendix section

**Approach:** Keep all content in one file but restructure with a clear `## Appendix: Research Details` section at the bottom. Phase 0 acceptance criteria trimmed to Phase 0-only items. Code blocks, performance notes, and Phase A checklists move below the fold.

**Pros:**
- Single file, no cross-referencing needed
- Preserves full context for anyone reading the plan
- Lower effort than extraction

**Cons:**
- Document stays long (~450 lines), just reorganized
- Appendix may still blur the boundary between phases
- Readers still see Phase A content and may confuse scope

**Effort:** Very low (30-60 minutes)

**Risk:** Low -- but doesn't fully solve the "when is Phase 0 done?" problem

---

### Option 3: Create Phase A input tracker as separate todo items

**Approach:** Extract each Phase A deliverable currently embedded in the plan into its own todo file (or add to existing Phase A todo 003). Remove them from the Phase 0 plan entirely. The plan links to these todos instead of inlining the content.

**Pros:**
- Each deliverable becomes independently trackable
- Phase 0 plan closes cleanly
- Follows the existing todo-driven workflow

**Cons:**
- May create many small todo files
- Some findings are better as grouped context than isolated tasks
- Partially done already (todos 003-007 exist but don't capture all items)

**Effort:** Medium (2-3 hours to extract, create, cross-reference)

**Risk:** Low

## Technical Details

**Affected file:** `docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md`

**Current structure (approximate line ranges):**
- Lines 1-66: Frontmatter, summary, overview, problem statement (keep)
- Lines 67-120: Proposed solution, PoC scope, decision rubric (keep)
- Lines 121-234: Technical considerations -- import maps, SDK comparison (keep, trim code blocks)
- Lines 235-261: Shared constants code blocks (move -- Phase A implementation detail)
- Lines 263-303: Agent-native design improvements (move -- Phase A deliverable)
- Lines 305-327: Security considerations (keep summary, move detailed test vectors)
- Lines 328-345: Logging migration, performance (move -- Phase A details)
- Lines 347-378: System-wide impact (keep, trim code blocks)
- Lines 380-427: Acceptance criteria (trim to Phase 0 only)
- Lines 429-492: Dependencies, risks, sources (keep)

**Phase 0 acceptance criteria should be limited to:**
- PoC built and validated
- Decision documented with evidence
- Migration scope and rollback plan confirmed
- SDK version resolution verified
- Test mock surface audited

## Acceptance Criteria

- [ ] Plan is under 350 lines
- [ ] Phase 0 acceptance criteria only reference Phase 0 deliverables (no Phase A checkboxes)
- [ ] No implementation code blocks in main body (moved to appendix or reference doc)
- [ ] All extracted Phase A items are traceable in existing or new todo files
- [ ] Plan still contains all information needed to execute and close Phase 0

## Work Log

### 2026-03-04 - Resolved

**By:** Claude Code

**Actions:**
- Removed Enhancement Summary section (28 lines of meta-commentary)
- Replaced `withLogging` code block (~20 lines) with prose reference to todo 011
- Replaced agent-native design section (~40 lines of tables/code) with 4-line summary
- Replaced shared constants code block (~16 lines) with one-line reference
- Replaced logging section (~8 lines) with 2-line summary
- Replaced performance section (~8 lines) with 2-line summary referencing corrected figures (todos 016, 018)
- Removed Community Intelligence section (4 lines)
- Replaced acceptance criteria (~46 lines of Phase A/fix-while-migrating checkboxes) with 10-line Phase 0-only list + reference to todos
- Added flag injection (P1) and safeEnv hotfix timing (P1) to security section
- Fixed `ZodRawShapeCompat` -> `ZodRawShape` (P2 bonus)
- Result: 317 lines (down from 492, -35%)

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created from code review of Phase 0 architecture gate plan
- Identified ~150 lines (30%) of removable content that belongs in Phase A

**Learnings:**
- Research deepening sessions are valuable but need discipline about scope boundaries
- A plan that can't close cleanly creates drag on execution velocity

## Resources

- [Phase 0 plan](docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md) -- the document under review
- [Phase 0 todo](todos/001-ready-p1-phase-0-architecture-gate.md) -- original 108-line scope
- [Phase A todo](todos/003-ready-p1-phase-a-foundation.md) -- downstream phase that should own extracted items
