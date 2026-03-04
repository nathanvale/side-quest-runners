---
status: ready
priority: p2
issue_id: "014"
tags: [code-review, security, validation]
dependencies: []
---

# validatePathOrDefault Bypass Vectors

## Problem Statement

`validatePathOrDefault` in `@side-quest/core/validation` has two bypass vectors that the plan does not flag:

1. **Empty string bypass** -- The function checks for `undefined` and `null` to apply the default path, but an empty string `""` passes through as a non-default value. After `trim()`, it becomes `""`, which `path.resolve()` resolves to the current working directory. This may or may not be the intended behavior, but it silently skips validation that would otherwise apply to the default path.

2. **Null byte injection** -- A path containing `\x00` (null byte) can evade the `trim()` check. While Bun's filesystem APIs typically reject null bytes, the validation function itself does not strip or reject them. If the path passes validation but is later used in a context that truncates at the null byte (e.g., C-level filesystem calls), the validated path and the accessed path diverge.

The plan mentions the skip-on-default behavior (line 313: "`validatePathOrDefault` skips validation when `path === defaultPath`") but does not identify the empty string case or null byte vector as issues requiring an explicit Phase A decision.

## Findings

1. `validatePathOrDefault` signature: `(path: string | undefined, defaultPath: string) => string`
2. When `path` is `undefined` or `null`, returns `defaultPath` without validation -- this is documented.
3. When `path` is `""` (empty string), it does not match `undefined`/`null`, so it proceeds to validation with an empty string. `path.resolve("")` returns `process.cwd()`.
4. The plan's security section (lines 306-319) covers symlink traversal, `../` traversal, absolute paths, and shell metacharacters but does not mention empty string or null byte as test vectors for `validatePathOrDefault` specifically (null bytes are mentioned for `validateShellSafePattern`).
5. The plan's test vector list (line 311) includes "null byte injection (`\x00`)" but this is in the general validation context, not specifically flagged as a `validatePathOrDefault` bypass.

## Proposed Solutions

### Solution 1: Treat empty string same as undefined (apply default)

Add empty string to the "use default" condition:

```typescript
function validatePathOrDefault(path: string | undefined, defaultPath: string): string {
  if (path === undefined || path === null || path.trim() === '') {
    return defaultPath
  }
  // ... proceed with validation
}
```

- **Pros:** Eliminates the empty string bypass. Intuitive behavior -- empty input means "use the default." Defensive without being surprising.
- **Cons:** Could be a behavioral change if any caller intentionally passes `""` to mean "current directory." Needs audit of call sites.
- **Effort:** Trivial (1-2 lines of code)
- **Risk:** Low. Empty string as intentional input is unlikely given the function's semantics.

### Solution 2: Add null byte stripping before trim()

Strip null bytes and other control characters before processing:

```typescript
function validatePathOrDefault(path: string | undefined, defaultPath: string): string {
  if (path === undefined || path === null) {
    return defaultPath
  }
  const sanitized = path.replace(/[\x00-\x1f\x7f]/g, '')
  // ... proceed with validation using sanitized
}
```

- **Pros:** Eliminates null byte injection vector. Also strips other control characters (CR, LF, tab) that could cause path interpretation issues.
- **Cons:** Silent stripping could mask malicious input. Rejection (throwing an error) might be more appropriate for security-critical code.
- **Effort:** Trivial (2-3 lines of code)
- **Risk:** Low. Control characters in file paths are never legitimate on macOS/Linux.

### Solution 3: Both fixes plus explicit Phase A decision in plan

Apply both fixes and add them as explicit Phase A acceptance criteria. Also consider rejecting (throwing) rather than stripping null bytes:

```typescript
function validatePathOrDefault(path: string | undefined, defaultPath: string): string {
  if (path === undefined || path === null || path.trim() === '') {
    return defaultPath
  }
  if (/[\x00]/.test(path)) {
    throw new Error('Path contains null byte')
  }
  // ... proceed with validation
}
```

- **Pros:** Most secure approach. Empty string handled gracefully, null bytes rejected explicitly. Both vectors documented and tested.
- **Cons:** Slightly more scope for Phase A. Throwing on null bytes could surface as an unhandled error if callers don't expect it.
- **Effort:** Small (1-2 hours including tests)
- **Risk:** Low. Both behaviors are clearly correct from a security perspective.

## Technical Details

The `validatePathOrDefault` function is used by:
- **tsc-runner** -- validates the `path` parameter (path to tsconfig.json)
- **biome-runner** -- validates the `path` parameter (path to check/fix)

Neither bun-runner tool uses `validatePathOrDefault` (it uses `validatePath` and `validateShellSafePattern` instead).

The function's security guarantee is: "returned path is within the git repository root." The empty string bypass could return `process.cwd()` without verifying it's in the repo. The null byte bypass could cause validation to pass on a path that, when accessed, resolves to a different location.

## Acceptance Criteria

- [ ] `validatePathOrDefault` handles empty string input (either applies default or explicitly rejects)
- [ ] `validatePathOrDefault` handles null byte input (strips or rejects)
- [ ] Behavior for both edge cases is documented in JSDoc
- [ ] Test vectors added for empty string and null byte paths
- [ ] Phase A plan updated with explicit decision on both vectors

## Work Log

| Date | Note |
|------|------|
| 2026-03-04 | Code review finding documented |

## Resources

- Plan section: Security considerations (lines 306-319)
- Plan section: Test vectors (line 311)
- `@side-quest/core` validation module source
- [OWASP Null Byte Injection](https://owasp.org/www-community/attacks/Embedding_Null_Code)
- [Snyk - Path Traversal in MCP Servers](https://snyk.io/articles/preventing-path-traversal-vulnerabilities-in-mcp-server-function-handlers/)
