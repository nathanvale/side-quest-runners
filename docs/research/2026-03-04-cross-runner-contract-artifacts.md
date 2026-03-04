---
created: 2026-03-04
deepened: 2026-03-04
title: Cross-Runner Contract Artifacts -- Tool Descriptions, OutputSchema, and Annotations
type: research
tags: [mcp, prompt-engineering, descriptions, outputSchema, annotations, discoverability]
project: side-quest-runners
status: approved
todo: "002"
---

# Cross-Runner Contract Artifacts

Prompt-engineering artifacts for all 7 MCP tools across 3 runners. Each tool gets a `title`, improved `description` (what/when/returns/boundaries), `outputSchema`, and audited annotations. Ready for copy-paste into implementation.

Reference: [MCP best practices research](https://github.com/nathanvale/side-quest-marketplace/blob/main/docs/research/2026-03-03-mcp-best-practices-prompt-engineering.md)

---

## Enhancement Summary

**Deepened on:** 2026-03-04
**Research agents used:** 7 (best-practices-researcher, architecture-strategist, pattern-recognition-specialist, agent-native-reviewer, code-simplicity-reviewer, agent-native-architecture skill, framework-docs-researcher)

### Critical Findings

1. **bun-runner throws on test failure** -- outputSchema only describes the success path; structured failure data is lost when `wrapToolHandler` converts thrown errors to `isError: true` text
2. **snake_case vs camelCase mixing** -- biome-runner uses `error_count`/`warning_count`/`unformatted_files` while tsc-runner uses `errorCount`/`configPath`; standardize to camelCase
3. **Claude Code ignores `structuredContent`** -- it reads only the `content[].text` field; `outputSchema` adds validation value but doesn't change how the LLM processes results
4. **Title technology prefix inconsistency** -- only `tsc_check` includes "TypeScript" in its title; either add technology to all or remove from all
5. **`context` field never populated by `bun_runTests`** -- the schema includes it but the implementation drops `undefined` during JSON serialization

### New Considerations Discovered

- TypeScript SDK outputSchema validation has known bugs with `z.optional()` and `z.union()` (issue #1308) -- only use bare `z.object()`
- `destructiveHint` defaults to `true` in the spec -- not setting it means the client assumes destructive
- Best-practice description length is 50-150 tokens, not 200; the current descriptions at ~55 tokens are in the sweet spot
- The `biome check` command may NOT include formatting by default -- verify before claiming `biome_lintCheck` checks formatting
- Multiple agents recommend adding a `success: boolean` top-level field to all outputSchemas for consistent agent loop-termination logic

---

## Description Pattern

Every description follows this structure:

```text
WHAT:       One sentence - what the tool does (verb-object opening).
WHEN:       When to use it (and cross-tool disambiguation).
RETURNS:    What the output contains.
BOUNDARIES: What it does NOT do (prevents misrouting).
```

Token budget: 50-150 tokens per description (sweet spot per [Layered Systems research](https://layered.dev/mcp-tool-schema-bloat-the-hidden-token-tax-and-how-to-fix-it/)).

### Research Insights

- **Descriptions are routing signals, not documentation.** Claude picks tools based on descriptions, not names. The LLM scans descriptions as selection criteria during tool choice.
- **Lead with verb-object** -- "Check files...", "Run tests...", not "This tool allows you to..."
- **Negative boundaries matter most** -- saying what a tool does NOT do reduces confusion pairs more effectively than explaining what it does
- **Cross-references should use exact tool names** -- "For linting use biome_lintCheck" is machine-parseable; "use another tool" is not
- **Put parameter details in schema descriptions, not the tool description** -- the tool description is for SELECTION; schema descriptions are for INVOCATION (SEP-1382)
- **Implementation details are noise** -- agents don't need to know about workspace-aware discovery, timeout values, or internal commands; focus on WHAT/WHEN/RETURNS/BOUNDARIES

Sources:
- [SEP-1382: Documentation Best Practices for MCP Tools](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1382)
- [MCP Tool Schema Bloat - Layered Systems](https://layered.dev/mcp-tool-schema-bloat-the-hidden-token-tax-and-how-to-fix-it/)
- [MCP Filesystem Server (reference implementation)](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts)

---

## 1. tsc_check (tsc-runner)

### Current

```text
Run TypeScript type checking (tsc --noEmit) using the nearest tsconfig/jsconfig.
```

### Proposed

**title:** `"TypeScript Type Checker"`

**description:**

```text
Type-check TS/JS with tsc --noEmit using nearest tsconfig/jsconfig. Use after edits. Returns errorCount and file/line/column/message diagnostics. Read-only. Not for lint/format/tests; use biome_lintCheck or bun_runTests.
```

### Research Insights

**Descriptions:**
- Remove ".ts/.tsx/.js/.jsx" file extension list -- "after editing TypeScript files" suffices; the agent knows .tsx is TypeScript
- Consider trimming "Automatically finds the nearest tsconfig.json or jsconfig.json from the given path" to just "Finds the nearest tsconfig/jsconfig" -- implementation detail the agent doesn't need for routing

**Titles:**
- "TypeScript Type Checker" is the only title with a technology prefix. For consistency, either drop "TypeScript" (making it "Type Checker") or add technology prefixes to ALL titles ("Bun Test Runner", "Biome Lint Checker", etc.)
- Recommendation: Add technology prefixes to all -- in multi-server environments, generic titles like "Lint Checker" are ambiguous

**Annotations:**

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct, no change needed.

**outputSchema:**

```json
{
  "type": "object",
  "properties": {
    "cwd": {
      "type": "string",
      "description": "Working directory where tsc was executed"
    },
    "configPath": {
      "type": "string",
      "description": "Path to the tsconfig.json or jsconfig.json used"
    },
    "timedOut": {
      "type": "boolean",
      "description": "Whether the check timed out (30s limit)"
    },
    "exitCode": {
      "type": "integer",
      "description": "tsc exit code (0 = no errors)"
    },
    "errors": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string", "description": "File path relative to cwd" },
          "line": { "type": "integer", "description": "1-based line number" },
          "col": { "type": "integer", "description": "1-based column number" },
          "code": { "type": "string", "description": "TypeScript diagnostic code (for example TS2345)" },
          "message": { "type": "string", "description": "Error message from tsc" }
        },
        "required": ["file", "line", "col", "code", "message"]
      },
      "description": "Array of type errors found"
    },
    "errorCount": {
      "type": "integer",
      "description": "Total number of type errors"
    }
  },
  "required": ["exitCode", "errors", "errorCount"]
}
```

### Research Insights (outputSchema)

- **Relax `required` array** -- `cwd`, `configPath`, and `timedOut` are debugging metadata, not agent-actionable fields. Only `exitCode`, `errors`, and `errorCount` are needed for agent decision-making. Keep all fields in `properties` but remove non-essential ones from `required`.
- **`col` abbreviation** -- `column` would be more LLM-friendly (LLMs handle full words more reliably), but this matches the existing implementation and is unlikely to cause issues.
- **Consider adding `success: boolean`** -- a top-level boolean enables consistent loop-termination logic without the agent needing to know that `exitCode === 0` means success for this specific tool.

---

## 2. bun_runTests (bun-runner)

### Current

```text
Run tests using Bun and return a concise summary of failures. Use this instead of 'bun test' to save tokens and get structured error reports.
```

### Proposed

**title:** `"Bun Test Runner"`

**description:**

```text
Run Bun tests for suite-level regression checks. Returns pass/fail counts and structured failures. Read-only. No fixes or coverage. Use bun_testFile for one file; bun_testCoverage for coverage.
```

### Research Insights

**Descriptions:**
- Removed "Supports workspace-aware test discovery across all packages" -- implementation detail the agent doesn't need for routing
- Added "Bun" to title for technology prefix consistency

**Critical implementation issue -- throw on failure:**
- Lines 286-291 of `packages/bun-runner/mcp/index.ts` throw when `summary.failed > 0`
- When tests fail, the agent gets `isError: true` with unstructured text instead of the structured JSON described by outputSchema
- Test failures are diagnostic results, not tool failures -- the agent needs the structured data to decide what to fix
- **Action required:** Refactor to always return structured JSON. Use `isError: false` for test failures. Reserve `isError: true` for actual tool failures (timeout, spawn error, invalid path)

**`context` field never populated:**
- `bun_runTests` calls `formatTestSummary(summary, format)` without a context argument
- `JSON.stringify` silently drops `undefined` values
- Either remove `context` from the schema (since it's echo-back of input) or pass `pattern` as context: `formatTestSummary(summary, format, pattern)`
- Recommendation: Remove `context` entirely -- agents already know what they asked for

**Annotations:**

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct.

**outputSchema:**

```json
{
  "type": "object",
  "properties": {
    "passed": {
      "type": "integer",
      "description": "Number of tests that passed"
    },
    "failed": {
      "type": "integer",
      "description": "Number of tests that failed"
    },
    "total": {
      "type": "integer",
      "description": "Total number of tests run"
    },
    "failures": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string", "description": "Test file path" },
          "line": { "type": "integer", "description": "Line number of failure" },
          "message": { "type": "string", "description": "Failure message" },
          "stack": { "type": "string", "description": "Stack trace (if available)" }
        },
        "required": ["file", "message"]
      },
      "description": "Array of test failures (empty when all pass)"
    }
  },
  "required": ["passed", "failed", "total", "failures"]
}
```

### Research Insights (outputSchema)

- **Removed `context` field** -- echo-back of input is a YAGNI violation; agents never need to read their own request back from the output
- **Consider adding `timedOut: boolean`** -- for consistency with `tsc_check`; currently timeouts use a sentinel value `file: 'timeout'` which is fragile

---

## 3. bun_testFile (bun-runner)

### Current

```text
Run tests for a specific file only. More targeted than bun_runTests with a pattern.
```

### Proposed

**title:** `"Bun Single File Test Runner"`

**description:**

```text
Run Bun tests for one exact test file path with structured failures. Use during focused debugging. Read-only. Not full-suite or coverage. Use bun_runTests for suite checks; bun_testCoverage for coverage.
```

### Research Insights

- Same throw-on-failure issue as `bun_runTests` (lines 338-342)
- Input parameter uses `file` while every other tool uses `path` -- consider renaming to `path` for consistency, or at minimum document why it differs (accepts files only, not directories)
- Added "Bun" to title for consistency

**Annotations:**

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct.

**outputSchema:**

Same as `bun_runTests` -- reuse the same schema. In implementation, extract a shared constant.

---

## 4. bun_testCoverage (bun-runner)

### Current

```text
Run tests with code coverage and return a summary. Shows overall coverage percentage and files with low coverage.
```

### Proposed

**title:** `"Bun Test Coverage Reporter"`

**description:**

```text
Run Bun tests with coverage. Returns test summary, coverage percent, and low-coverage files. Read-only and slower than bun_runTests. No fixes. Use bun_runTests for faster no-coverage checks.
```

### Research Insights

- Removed "Has a 60-second timeout (longer than bun_runTests)" -- timeout values are operational detail, not routing signals
- Same throw-on-failure issue as other bun-runner tools (line 391)
- Added "Bun" to title for consistency

**Annotations:**

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct.

**outputSchema:**

```json
{
  "type": "object",
  "properties": {
    "summary": {
      "type": "object",
      "properties": {
        "passed": { "type": "integer", "description": "Number of tests that passed" },
        "failed": { "type": "integer", "description": "Number of tests that failed" },
        "total": { "type": "integer", "description": "Total number of tests run" },
        "failures": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "file": { "type": "string" },
              "line": { "type": "integer" },
              "message": { "type": "string" },
              "stack": { "type": "string" }
            },
            "required": ["file", "message"]
          }
        }
      },
      "required": ["passed", "failed", "total", "failures"]
    },
    "coverage": {
      "type": "object",
      "properties": {
        "percent": {
          "type": "number",
          "description": "Overall coverage percentage (0-100)"
        },
        "uncovered": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "file": { "type": "string", "description": "File path with low coverage" },
              "percent": { "type": "number", "description": "Coverage percent for this file (0-100)" }
            },
            "required": ["file", "percent"]
          },
          "description": "Files with coverage below 50% and their coverage percentages"
        }
      },
      "required": ["percent", "uncovered"]
    }
  },
  "required": ["summary", "coverage"]
}
```

---

## 5. biome_lintCheck (biome-runner)

### Current

```text
Run Biome linter on files and return structured errors. Use this to check for code quality issues without fixing them.
```

### Proposed

**title:** `"Biome Lint Checker"`

**description:**

```text
Check files with Biome and return lint/format diagnostics without writing changes. Use after edits. Read-only. No fixes or type checks. Use biome_lintFix to fix; use tsc_check for types.
```

### Research Insights

**Critical -- verify formatting claim:**
- The original description said "Runs both lint rules and formatting checks" but `runBiomeCheck` runs `biome check --reporter=json`
- Biome's `check` subcommand only includes formatting when `--formatter-enabled=true` is passed or when the biome config enables it for `check`
- **Action required:** Verify whether `biome check` actually catches formatting issues in this project's config. If not, remove the formatting claim from the description
- Removed the formatting claim from the proposed description until verified

**Naming:**
- Added "Biome" to title for technology prefix consistency
- Standardized "Read-only" capitalization (was "read-only mode" in the original)

**Annotations:**

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct.

**outputSchema:**

```json
{
  "type": "object",
  "properties": {
    "errorCount": {
      "type": "integer",
      "description": "Number of lint errors"
    },
    "warningCount": {
      "type": "integer",
      "description": "Number of lint warnings"
    },
    "diagnostics": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string", "description": "File path" },
          "line": { "type": "integer", "description": "Line number" },
          "message": { "type": "string", "description": "Diagnostic message" },
          "code": { "type": "string", "description": "Biome rule code (e.g., 'lint/suspicious/noExplicitAny')" },
          "severity": { "type": "string", "enum": ["error", "warning", "info"], "description": "Diagnostic severity" },
          "suggestion": { "type": "string", "description": "Fix suggestion (if available)" }
        },
        "required": ["file", "line", "message", "code", "severity"]
      },
      "description": "Array of lint diagnostics"
    }
  },
  "required": ["errorCount", "warningCount", "diagnostics"]
}
```

### Research Insights (outputSchema)

- **Standardized to camelCase** -- changed `error_count` -> `errorCount`, `warning_count` -> `warningCount` to match tsc-runner/bun-runner conventions. This requires updating the `LintSummary` interface and all JSON output in biome-runner.
- **`suggestion` field concern** -- currently `JSON.stringify(d.advice)` produces a raw JSON blob as a string. An agent receiving `"{\"message\":\"Remove this.\",\"codeAction\":{...}}"` must parse JSON-within-JSON. Consider parsing into a human-readable string instead, or expanding to a structured object.

---

## 6. biome_lintFix (biome-runner)

### Current

```text
Run Biome linter with --write to auto-fix issues. Returns count of fixed issues and any remaining unfixable errors.
```

### Proposed

**title:** `"Biome Lint & Format Fixer"`

**description:**

```text
Auto-fix Biome lint/format issues with --write, then return remaining diagnostics. Use after biome_lintCheck. Modifies files. No type checks. Use biome_lintCheck for read-only checks; use tsc_check for types.
```

### Research Insights

- Removed "Runs both 'biome format --write' and 'biome check --write'" -- implementation detail the agent doesn't need
- Removed "this is a destructive operation" -- redundant with `destructiveHint: true` annotation
- Added "Does NOT check types" boundary -- missing from original, inconsistent with siblings `biome_lintCheck` and `biome_formatCheck` which both have it
- Added "Biome" to title for consistency

**Annotations:**

```json
{
  "readOnlyHint": false,
  "destructiveHint": true,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct.

**outputSchema:**

```json
{
  "type": "object",
  "properties": {
    "fixed": {
      "type": "integer",
      "description": "Total number of issues auto-fixed (format + lint)"
    },
    "remaining": {
      "type": "object",
      "properties": {
        "errorCount": { "type": "integer", "description": "Remaining errors after fix" },
        "warningCount": { "type": "integer", "description": "Remaining warnings after fix" },
        "diagnostics": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "file": { "type": "string" },
              "line": { "type": "integer" },
              "message": { "type": "string" },
              "code": { "type": "string" },
              "severity": { "type": "string", "enum": ["error", "warning", "info"] },
              "suggestion": { "type": "string" }
            },
            "required": ["file", "line", "message", "code", "severity"]
          },
          "description": "Diagnostics that could not be auto-fixed"
        }
      },
      "required": ["errorCount", "warningCount", "diagnostics"]
    }
  },
  "required": ["fixed", "remaining"]
}
```

---

## 7. biome_formatCheck (biome-runner)

### Current

```text
Check if files are properly formatted without making changes. Returns list of unformatted files.
```

### Proposed

**title:** `"Biome Format Checker"`

**description:**

```text
Check Biome formatting compliance and list unformatted files. Use for CI/pre-commit format gates. Read-only. No fixes or type checks. Use biome_lintFix to fix formatting; biome_lintCheck for lint diagnostics.
```

### Research Insights

**YAGNI question:**
- The code-simplicity-reviewer flagged `biome_formatCheck` as a potential YAGNI violation since `biome_lintCheck` (may) already cover formatting
- However, the agent-native-architecture review notes this provides a useful "format-only" read path
- **Decision:** Keep for now. It's already implemented and provides a useful CI/format-only use case. Removing it would be a breaking change with no clear benefit.

**Annotations:**

```json
{
  "readOnlyHint": true,
  "destructiveHint": false,
  "idempotentHint": true,
  "openWorldHint": false
}
```

Status: already correct.

**outputSchema:**

```json
{
  "type": "object",
  "properties": {
    "formatted": {
      "type": "boolean",
      "description": "True if all files pass formatting checks"
    },
    "unformattedFiles": {
      "type": "array",
      "items": { "type": "string" },
      "description": "List of file paths that need formatting (empty when formatted is true)"
    }
  },
  "required": ["formatted", "unformattedFiles"]
}
```

### Research Insights (outputSchema)

- **Standardized to camelCase** -- changed `unformatted_files` -> `unformattedFiles`
- **Thin output** -- only returns file paths, no line-level detail. This is fine because the expected workflow is `biome_formatCheck` -> `biome_lintFix`, not manual fixing

---

## Cross-Tool Disambiguation Matrix

This table shows how descriptions prevent misrouting between similar tools:

| Confusion Pair | Disambiguation Strategy |
|----------------|------------------------|
| `bun_runTests` vs `bun_testFile` | runTests: "all tests, optional pattern filter". testFile: "single specific file path, faster iteration". Each points to the other. |
| `bun_runTests` vs `bun_testCoverage` | runTests: "verify nothing is broken, faster". testCoverage: "coverage health, always runs all tests". testCoverage says "use bun_runTests (faster)". |
| `biome_lintCheck` vs `biome_lintFix` | lintCheck: "reports but does NOT modify files". lintFix: "MODIFIES FILES ON DISK". Each points to the other. |
| `biome_lintCheck` vs `biome_formatCheck` | lintCheck: "lint errors and warnings". formatCheck: "formatting rules only". formatCheck says "for lint rules use lintCheck". |
| `biome_formatCheck` vs `biome_lintFix` | formatCheck: "read-only, does NOT fix". lintFix: "auto-fix with --write". formatCheck says "To auto-fix, use biome_lintFix". |
| `biome_lintCheck` vs `tsc_check` | Both say "does NOT check [the other concern]" and point to the other tool by name. |
| `biome_lintFix` vs `tsc_check` | lintFix: "Does NOT check types -- for type errors use tsc_check". |

---

## Implementation Actions Required

These are code changes discovered during the deepening research that must happen alongside applying the contract artifacts.

### 1. [CRITICAL] Fix throw-on-failure in bun-runner

**File:** `packages/bun-runner/mcp/index.ts` lines 286-291, 338-342, 387-392

**Problem:** All three bun-runner tools throw when tests fail, causing `isError: true` with unstructured text. The outputSchema only describes the success path.

**Fix:** Return test failures as successful results with structured JSON. The `failed > 0` field is sufficient for agents to know there are failures. Reserve `isError: true` for actual tool failures (timeout, spawn error, invalid path).

**Why:** Test failures are diagnostic results, not tool failures. The raw-sdk-poc at `packages/tsc-runner/mcp/raw-sdk-poc.ts` already does this correctly for `tsc_check`.

### 2. [CRITICAL] Standardize output keys to camelCase

**File:** `packages/biome-runner/mcp/index.ts`

**Problem:** biome-runner uses snake_case (`error_count`, `warning_count`, `unformatted_files`) while tsc-runner and bun-runner use camelCase (`errorCount`, `configPath`).

**Fix:** Update the `LintSummary` interface and all JSON output to use camelCase: `errorCount`, `warningCount`, `unformattedFiles`.

### 3. [MEDIUM] Verify biome_lintCheck covers formatting

**Problem:** The description claims formatting coverage but `biome check` may not include formatting by default.

**Fix:** Test by introducing a formatting-only issue. If `biome check` doesn't catch it, either add `--formatter-enabled=true` or update the description.

### 4. [MEDIUM] Remove or populate `context` field in bun_runTests

**Problem:** `bun_runTests` includes `context` in the schema but never populates it (drops as `undefined`).

**Fix:** Either remove from schema (recommended) or pass `pattern` as context argument.

### 5. [LOW] Consider adding `timedOut` to bun-runner schemas

**Problem:** Timeouts in bun-runner use sentinel value `file: 'timeout'` instead of a proper boolean field.

**Fix:** Add `timedOut: boolean` for consistency with `tsc_check`.

---

## outputSchema Implementation Notes

### Claude Code ignores `structuredContent`

Per community testing ([zenn.dev/7shi](https://zenn.dev/7shi/articles/20250710-output-schema?locale=en)): Claude Code reads only the `content[].text` field. When a tool returns only `structuredContent` without `content`, Claude reports "completed successfully with no output."

**Implication:** Always return meaningful text in `content` regardless of `outputSchema`. The `structuredContent` field provides validation and programmatic client support, but does not change how Claude processes results.

### TypeScript SDK known bugs

| Issue | Impact | Workaround |
|-------|--------|------------|
| [#1308](https://github.com/modelcontextprotocol/typescript-sdk/issues/1308) | `outputSchema` validation crashes with `z.optional()`, `z.nullable()`, `z.union()` | Only use bare `z.object()` for outputSchema |
| [#1149](https://github.com/modelcontextprotocol/typescript-sdk/issues/1149) | TypeScript SDK enforces `type: "object"` even though spec allows arrays | Use object wrapper for batch results |
| [#837](https://github.com/modelcontextprotocol/typescript-sdk/issues/837) | External `interface` types cause TypeScript errors with `structuredContent` | Use inline types, not imported interfaces |

### Dual-return pattern (required for backwards compatibility)

When `outputSchema` is defined, return BOTH `content` and `structuredContent`:

```typescript
return {
  content: [{ type: 'text', text: JSON.stringify(output) }],
  structuredContent: output
};
```

### Error handling with outputSchema

Per [GitHub issue #654](https://github.com/modelcontextprotocol/typescript-sdk/issues/654): When `isError: true`, the SDK validates `structuredContent` against `outputSchema` BEFORE checking the error flag. This means error responses must either match the schema or not include `structuredContent`.

**Implication for bun-runner:** This reinforces the recommendation to return test failures as successful results with structured data, not as `isError: true`.

---

## Annotations Audit Summary

| Tool | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Status |
|------|:---:|:---:|:---:|:---:|--------|
| `tsc_check` | true | false | true | false | Correct |
| `bun_runTests` | true | false | true | false | Correct |
| `bun_testFile` | true | false | true | false | Correct |
| `bun_testCoverage` | true | false | true | false | Correct |
| `biome_lintCheck` | true | false | true | false | Correct |
| `biome_lintFix` | false | true | true | false | Correct |
| `biome_formatCheck` | true | false | true | false | Correct |

### Research Insights (Annotations)

- **`destructiveHint` defaults to `true`** -- if not set, clients assume the tool is destructive. Always explicitly set `destructiveHint: false` on read-only tools.
- **`readOnlyHint: true` makes `destructiveHint` and `idempotentHint` semantically redundant** -- a read-only tool by definition is neither destructive nor non-idempotent. Setting them explicitly is still good practice for clarity.
- **ChatGPT Dev Mode** visually labels tools as "read" or "write" based on `readOnlyHint` -- tools without this annotation show as write tools.

Sources:
- [MCP Tool Annotations spec](https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/#annotations)
- [Nick Taylor: MCP tools showing as write tools in ChatGPT](https://dev.to/nickytonline/quick-fix-my-mcp-tools-were-showing-as-write-tools-in-chatgpt-dev-mode-3id9)

---

## Agent-Native Architecture Assessment

Assessment using the [agent-native-architecture](https://github.com) skill's core principles:

### Parity: Strong

All 7 common developer workflows have tool coverage (check types, check lint, check format, fix lint/format, run tests, run single test, run coverage). One minor gap: `biome_formatCheck` (read) has no corresponding `biome_formatFix` (write) -- format fixes are bundled into `biome_lintFix`. This is an intentional design decision: the single fix path is simpler.

### Granularity: Excellent

Each tool is a single conceptual action, not a workflow. No `validate_all` mega-tool. The agent composes workflows by calling tools in sequence: check -> fix -> recheck. This is exactly the agent-native pattern.

### Composability: Strong

Cross-tool disambiguation creates a navigable graph. An agent can compose a full "pre-commit quality check" workflow from a prompt alone by calling `tsc_check`, `biome_lintCheck`, `bun_runTests`, then `biome_lintFix` if needed.

### Anti-Patterns: None detected

No workflow-shaped tools, no agent-as-router pattern, no defensive tool design, no context starvation.

---

## Sources

- [MCP Tools Specification (2025-06-18)](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
- [MCP Specification - Schema](https://github.com/modelcontextprotocol/specification/blob/main/docs/specification/2025-06-18/schema.mdx)
- [TypeScript SDK - GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP Filesystem Server (reference implementation)](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/index.ts)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [SEP-1382: Documentation Best Practices](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1382)
- [MCP Tool Schema Bloat - Layered Systems](https://layered.dev/mcp-tool-schema-bloat-the-hidden-token-tax-and-how-to-fix-it/)
- [MCP Tool Overload - Lunar](https://www.lunar.dev/post/why-is-there-mcp-tool-overload-and-how-to-solve-it-for-your-ai-agents)
- [Claude Code ignores structuredContent - zenn.dev](https://zenn.dev/7shi/articles/20250710-output-schema?locale=en)
- [GitHub issue #654 - structuredContent blocks error reporting](https://github.com/modelcontextprotocol/typescript-sdk/issues/654)
- [GitHub issue #1308 - outputSchema validation crashes with optional](https://github.com/modelcontextprotocol/typescript-sdk/issues/1308)
- [MCP best practices research (internal)](https://github.com/nathanvale/side-quest-marketplace/blob/main/docs/research/2026-03-03-mcp-best-practices-prompt-engineering.md)
