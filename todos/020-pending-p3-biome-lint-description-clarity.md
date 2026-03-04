---
status: complete
priority: p3
issue_id: "020"
tags: [code-review, agent-native, discoverability]
dependencies: []
---

# Clarify biome_lintCheck description -- checks both lint and format rules

## Problem Statement

An AI agent may struggle to distinguish `biome_lintCheck` from `biome_formatCheck`. The lint check runs `biome check` (lint + format combined) while format check runs `biome format` (format only). The description doesn't clarify this overlap.

## Findings

1. **Agent-native reviewer:** Description disambiguation is strong across servers but weaker within biome-runner for the lintCheck vs formatCheck distinction.

## Proposed Solutions

### Option A: Add clarification to biome_lintCheck description (Recommended)

Add "Checks both lint rules and formatting" to the `biome_lintCheck` description.

- **Effort:** Trivial
- **Risk:** Low -- re-run discoverability benchmark after change

## Acceptance Criteria

- [ ] biome_lintCheck description mentions it checks both lint and format
- [ ] Discoverability A/B benchmark accuracy within 2% after change

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Agent-native reviewer |
