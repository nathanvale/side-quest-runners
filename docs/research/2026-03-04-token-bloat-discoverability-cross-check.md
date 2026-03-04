---
created: 2026-03-04
title: Token Bloat vs Discoverability Cross-Check (Half-Cut Set)
type: research
tags: [mcp, prompt-engineering, token-optimization, discoverability]
project: side-quest-runners
status: draft
related:
  - docs/research/2026-03-04-cross-runner-contract-artifacts.md
---

# Token Bloat vs Discoverability Cross-Check

Cross-check against Layered Systems guidance with a compressed description set that preserves tool routing clarity.

Reference:
- https://layered.dev/mcp-tool-schema-bloat-the-hidden-token-tax-and-how-to-fix-it/
- https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1382

## Executive Summary

- Proposed long-form set in contract artifact doc: `~774` estimated tokens (7 tool descriptions).
- Compressed half-cut set below: `~354` estimated tokens.
- Reduction: `~54.3%` while preserving explicit boundaries and cross-tool disambiguation.

## Measurement Method

- Approximation: `estimated_tokens = ceil(character_count / 4)`.
- Scope measured: tool `description` text only (not schema objects).
- Why this is useful: stable relative comparison for bloat control and regressions.

## Half-Cut Description Set (Copy-Paste)

### 1) `tsc_check`

**title:** `TypeScript Type Checker`

**description:**

```text
Type-check TS/JS with tsc --noEmit using nearest tsconfig/jsconfig. Use after edits. Returns errorCount and file/line/column/message diagnostics. Read-only. Not for lint/format/tests; use biome_lintCheck or bun_runTests.
```

### 2) `bun_runTests`

**title:** `Bun Test Runner`

**description:**

```text
Run Bun tests for suite-level regression checks. Returns pass/fail counts and structured failures. Read-only. No fixes or coverage. Use bun_testFile for one file; bun_testCoverage for coverage.
```

### 3) `bun_testFile`

**title:** `Bun Single File Test Runner`

**description:**

```text
Run Bun tests for one exact test file path with structured failures. Use during focused debugging. Read-only. Not full-suite or coverage. Use bun_runTests for suite checks; bun_testCoverage for coverage.
```

### 4) `bun_testCoverage`

**title:** `Bun Test Coverage Reporter`

**description:**

```text
Run Bun tests with coverage. Returns test summary, coverage percent, and low-coverage files. Read-only and slower than bun_runTests. No fixes. Use bun_runTests for faster no-coverage checks.
```

### 5) `biome_lintCheck`

**title:** `Biome Lint Checker`

**description:**

```text
Check files with Biome and return lint/format diagnostics without writing changes. Use after edits. Read-only. No fixes or type checks. Use biome_lintFix to fix; use tsc_check for types.
```

### 6) `biome_lintFix`

**title:** `Biome Lint & Format Fixer`

**description:**

```text
Auto-fix Biome lint/format issues with --write, then return remaining diagnostics. Use after biome_lintCheck. Modifies files. No type checks. Use biome_lintCheck for read-only checks; use tsc_check for types.
```

### 7) `biome_formatCheck`

**title:** `Biome Format Checker`

**description:**

```text
Check Biome formatting compliance and list unformatted files. Use for CI/pre-commit format gates. Read-only. No fixes or type checks. Use biome_lintFix to fix formatting; biome_lintCheck for lint diagnostics.
```

## Description Budget Table

| Tool | Words | Chars | Est. Tokens |
|---|---:|---:|---:|
| `tsc_check` | 24 | 220 | 55 |
| `bun_runTests` | 26 | 193 | 49 |
| `bun_testFile` | 29 | 203 | 51 |
| `bun_testCoverage` | 26 | 190 | 48 |
| `biome_lintCheck` | 28 | 186 | 47 |
| `biome_lintFix` | 27 | 208 | 52 |
| `biome_formatCheck` | 28 | 208 | 52 |
| **Total** | **188** | **1408** | **354** |

## A/B Discoverability Validation Plan

### Success Gates

- First-call correct tool selection drops by no more than `2%` absolute.
- Confusion-pair accuracy stays `>= 95%`.
- Mean extra correction calls increases by no more than `+0.1`.

### Test Matrix Template

| Prompt ID | Prompt | Expected Tool | Confusion Pair | Current Selected | Half-Cut Selected | Pass |
|---|---|---|---|---|---|---|
| P01 | "Check types before commit" | `tsc_check` | `tsc_check` vs `biome_lintCheck` |  |  |  |
| P02 | "Fix lint and formatting in src" | `biome_lintFix` | `biome_lintFix` vs `biome_lintCheck` |  |  |  |
| P03 | "Only check lint, do not change files" | `biome_lintCheck` | `biome_lintCheck` vs `biome_lintFix` |  |  |  |
| P04 | "Which files are unformatted?" | `biome_formatCheck` | `biome_formatCheck` vs `biome_lintCheck` |  |  |  |
| P05 | "Run all tests quickly" | `bun_runTests` | `bun_runTests` vs `bun_testCoverage` |  |  |  |
| P06 | "Run tests for src/auth/login.test.ts only" | `bun_testFile` | `bun_testFile` vs `bun_runTests` |  |  |  |
| P07 | "Give me coverage before release" | `bun_testCoverage` | `bun_testCoverage` vs `bun_runTests` |  |  |  |
| P08 | "Type errors only, no lint" | `tsc_check` | `tsc_check` vs `biome_lintCheck` |  |  |  |
| P09 | "Auto-fix style issues" | `biome_lintFix` | `biome_lintFix` vs `biome_formatCheck` |  |  |  |
| P10 | "Read-only formatting gate for CI" | `biome_formatCheck` | `biome_formatCheck` vs `biome_lintFix` |  |  |  |

### Confusion-Pair Scorecard Template

| Pair | Trials | Correct | Accuracy |
|---|---:|---:|---:|
| `bun_runTests` vs `bun_testFile` |  |  |  |
| `bun_runTests` vs `bun_testCoverage` |  |  |  |
| `biome_lintCheck` vs `biome_lintFix` |  |  |  |
| `biome_lintCheck` vs `biome_formatCheck` |  |  |  |
| `tsc_check` vs `biome_lintCheck` |  |  |  |

## Implementation Notes

- Keep parameter details in schema descriptions, not tool descriptions.
- Keep one explicit negative boundary and one explicit cross-reference per tool.
- If a confusion pair drops below gate, add one disambiguating sentence only to the weaker tool.
