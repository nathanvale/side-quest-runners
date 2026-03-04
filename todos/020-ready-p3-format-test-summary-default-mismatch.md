---
status: ready
priority: p3
issue_id: "020"
tags: [code-review, bun-runner, formatting]
dependencies: []
---

# formatTestSummary Default Parameter Mismatch with Tool Contract

## Problem Statement

In bun-runner (`packages/bun-runner/mcp/index.ts`, line 179), the `formatTestSummary` function has a default parameter of `ResponseFormat.MARKDOWN`:

```typescript
function formatTestSummary(
    summary: TestSummary,
    format: ResponseFormat = ResponseFormat.MARKDOWN,
    context?: string,
)
```

However, the `bun_runTests` tool's `response_format` input schema defaults to `'json'`:

```typescript
response_format: z.enum(['markdown', 'json']).optional().default('json')
```

This means calling `formatTestSummary(summary)` without a format argument produces markdown output, even though the tool contract promises JSON by default. Today this is not a bug because all callers explicitly pass the format (lines 283 and 335). But it creates a footgun: any future caller that omits the format argument will silently produce markdown when the tool contract says JSON.

During the Phase A migration, when handlers are rewritten to return `CallToolResult` with `structuredContent`, a developer could easily call `formatTestSummary(summary)` without the format and get the wrong output format.

## Findings

1. **Default mismatch:** `formatTestSummary` defaults to MARKDOWN; tool input schema defaults to JSON
2. **Current callers safe:** Both `bun_runTests` (line 283) and `bun_testFile` (line 335) explicitly pass `format`
3. **`bun_testCoverage` does not use `formatTestSummary`** -- it has its own formatting, but follows the same default-JSON pattern via input schema
4. **No test coverage:** `formatTestSummary` has no unit tests, so the default behavior is untested
5. **Migration risk:** During Phase A handler rewrite, the mismatch could cause silent format errors

## Proposed Solutions

### Option 1: Change formatTestSummary default to JSON

**Approach:** Change the default parameter from `ResponseFormat.MARKDOWN` to `ResponseFormat.JSON`:

```typescript
function formatTestSummary(
    summary: TestSummary,
    format: ResponseFormat = ResponseFormat.JSON,
    context?: string,
)
```

**Pros:**
- Aligns function default with tool contract default
- Zero behavioral change (all callers already pass format explicitly)
- Eliminates the footgun for future callers

**Cons:**
- If there are undiscovered callers that rely on markdown default, they would break (unlikely given the function is not exported)

**Effort:** Very low (single line change)

**Risk:** Very low -- function is private to the module, all callers pass format explicitly

---

### Option 2: Remove default parameter entirely (force explicit format)

**Approach:** Make `format` a required parameter by removing the default:

```typescript
function formatTestSummary(
    summary: TestSummary,
    format: ResponseFormat,
    context?: string,
)
```

**Pros:**
- Compile-time enforcement -- no caller can accidentally omit the format
- Most defensive approach
- Makes the contract explicit

**Cons:**
- Slightly more verbose at call sites (though they already pass it)
- Less convenient if the function is ever used in tests or debugging

**Effort:** Very low (remove default value)

**Risk:** Very low

---

### Option 3: Document as known footgun for Phase A

**Approach:** Add a JSDoc comment to `formatTestSummary` noting the default mismatch and that callers should always pass format explicitly. Defer the fix to Phase A when the function is being rewritten anyway.

**Pros:**
- Zero code change, zero risk
- Phase A rewrite will replace this function entirely

**Cons:**
- JSDoc warnings are easy to miss
- Leaves the footgun in place until Phase A

**Effort:** Very low (add comment)

**Risk:** Low -- the footgun is unlikely to trigger before Phase A

## Technical Details

**Affected file:** `packages/bun-runner/mcp/index.ts`

**Affected lines:**
- Line 177-180: `formatTestSummary` function signature with MARKDOWN default
- Line 283: `bun_runTests` handler passes format explicitly
- Line 335: `bun_testFile` handler passes format explicitly

**ResponseFormat enum values:**
```typescript
enum ResponseFormat {
    MARKDOWN = 'markdown',
    JSON = 'json',
}
```

**Tool input schemas (all default to JSON):**
- `bun_runTests`: `response_format: z.enum(['markdown', 'json']).optional().default('json')`
- `bun_testFile`: `response_format: z.enum(['markdown', 'json']).optional().default('json')`
- `bun_testCoverage`: `response_format: z.enum(['markdown', 'json']).optional().default('json')`

**Phase A context:** During migration, `formatTestSummary` will likely be replaced by direct `CallToolResult` construction with `structuredContent`. The default mismatch becomes moot once the function is rewritten. However, if the function survives into Phase A as-is (e.g., for the `content` text field), the mismatch should be fixed.

## Acceptance Criteria

- [ ] Default parameter of `formatTestSummary` aligned with tool contract (JSON), OR default removed entirely, OR documented as known footgun with Phase A fix planned
- [ ] No behavioral change to existing callers
- [ ] If fix is applied, existing tests (if any) still pass

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created from P3 code review finding on bun-runner
- Verified all current callers pass format explicitly (lines 283, 335)
- Confirmed function is module-private (not exported)

**Learnings:**
- Default parameters should match the contract of the calling context, not the function's "natural" default
- Private functions with mismatched defaults are low-severity but create migration risk

## Resources

- [bun-runner source](packages/bun-runner/mcp/index.ts) -- contains `formatTestSummary` and its callers
- [Phase 0 plan](docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md) -- migration context
- [Phase A todo](todos/003-ready-p1-phase-a-foundation.md) -- downstream phase where this function gets rewritten
