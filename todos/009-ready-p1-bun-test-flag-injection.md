---
status: ready
priority: p1
issue_id: "009"
tags: [code-review, security, bun-runner]
dependencies: []
---

# Bun Test Flag Injection via validateShellSafePattern

## Problem Statement

`validateShellSafePattern` does not reject patterns starting with `-` or `--`. A pattern like `--coverage`, `--bail=1`, or `--preload=./malicious.ts` passes validation and gets injected as a bun flag when passed to `['bun', 'test', pattern]`. This is a command flag injection vulnerability.

The attack surface: any MCP client (including AI agents) can pass a test pattern that modifies bun's behavior. While the array-based spawn prevents shell metacharacter injection, flag injection is a separate vector that array spawning does not mitigate -- bun interprets `--flag` arguments regardless of how they were passed.

The Phase 0 plan mentions hardening `validateShellSafePattern` to reject control characters but does not mention the leading-dash flag injection vector.

## Findings

1. **Current validation regex** in core's `validateShellSafePattern`: rejects `; & | < > \` $ \\` but allows `-` and `--` prefixed strings
2. **Bun test accepts flags positionally:** `bun test --bail=1` is valid and changes behavior. `bun test --preload=./file.ts` executes arbitrary code before tests run.
3. **Attack examples:**
   - `--bail=1` -- changes test runner behavior (stops after 1 failure)
   - `--preload=./attacker-controlled.ts` -- executes arbitrary TypeScript before test files load
   - `--coverage` -- enables coverage collection (information disclosure, changes output format)
   - `--timeout=1` -- causes tests to fail by setting an unreasonably low timeout
4. **Both bun-runner tools affected:** `bun_runTests` and `bun_testFile` both accept pattern arguments
5. **Biome-runner not affected:** biome CLI does not interpret leading-dash arguments the same way from path position
6. **The `--` separator defense:** `['bun', 'test', '--', pattern]` tells bun to treat everything after `--` as positional arguments (file/test name patterns), not flags

## Proposed Solutions

### Option 1: Add leading-dash check to validateShellSafePattern

**Approach:** Reject any pattern that starts with `-` (covers both `-flag` and `--flag`). Simple regex addition: `/^-/`.

**Pros:**
- Closes the vector completely at the validation layer
- Clear error message: "Pattern must not start with a dash"
- Easy to test

**Cons:**
- Could reject legitimate test patterns if someone names a file starting with `-` (extremely unlikely but possible)
- Only protects callers who use `validateShellSafePattern` -- other spawn calls are unprotected

**Effort:** Very low (add one regex check + tests)

**Risk:** Very low

---

### Option 2: Use `--` separator in bun test invocations

**Approach:** Change spawn calls from `['bun', 'test', pattern]` to `['bun', 'test', '--', pattern]` so bun treats everything after `--` as positional arguments, not flags.

**Pros:**
- Defense at the spawn boundary, not just validation
- Works regardless of what validation allows through
- Standard POSIX convention understood by all CLI tools

**Cons:**
- Requires verifying bun test respects `--` separator for all subcommands
- Doesn't help if other tools (biome, tsc) are called with user-provided arguments
- Callers must remember to use `--` -- not mechanical enforcement

**Effort:** Very low (change spawn argument arrays)

**Risk:** Low -- need to verify bun test handles `--` correctly

---

### Option 3: Both -- validate AND use separator (defense in depth)

**Approach:** Apply both Option 1 and Option 2. Reject leading-dash patterns in validation AND use `--` separator in spawn calls.

**Pros:**
- Defense in depth: two independent layers
- Validation catches the issue early with a clear error
- Separator prevents flag injection even if validation is bypassed or a new code path skips it
- Sets precedent for how all runner spawn calls should handle user input

**Cons:**
- Slightly more code to maintain
- Two places to update/test

**Effort:** Low (both changes are small)

**Risk:** Very low -- each layer is independently simple and well-understood

## Technical Details

**Affected files:**
- `packages/bun-runner/mcp/index.ts` -- spawn calls with pattern argument
- Core's `validation/index.ts` (or future `packages/runner-utils/validation.ts`) -- `validateShellSafePattern` function

**Current validateShellSafePattern (approximate):**
```typescript
export function validateShellSafePattern(pattern: string): string {
  if (/[;&|<>`$\\]/.test(pattern)) {
    throw new Error('Pattern contains unsafe shell characters')
  }
  return pattern
}
```

**Proposed addition (Option 1/3):**
```typescript
if (/^-/.test(pattern)) {
  throw new Error('Pattern must not start with a dash (flag injection)')
}
```

**Proposed spawn change (Option 2/3):**
```typescript
// Before
const args = ['test', pattern]
// After
const args = ['test', '--', pattern]
```

**Bun test `--preload` vector detail:** `bun test --preload=./setup.ts` executes `setup.ts` before any test file runs. If an attacker controls the pattern argument and a file exists at a predictable path, this is arbitrary code execution within the test environment.

## Acceptance Criteria

- [ ] Patterns starting with `-` are rejected by `validateShellSafePattern` with a clear error message
- [ ] `bun test` invocations in bun-runner use `--` separator before user-provided patterns
- [ ] Test coverage for leading-dash patterns: `-flag`, `--flag`, `--flag=value`, `--preload=file`
- [ ] Test coverage confirming valid patterns still pass: `*.test.ts`, `src/utils`, `my-component`
- [ ] JSDoc on `validateShellSafePattern` documents the flag injection vector and mitigation

## Work Log

### 2026-03-04 - Todo Created

**By:** Claude Code

**Actions:**
- Created from code review of Phase 0 architecture gate plan
- Identified flag injection vector not covered by existing validation or plan

**Learnings:**
- Shell metacharacter injection and flag injection are distinct attack vectors
- Array-based spawn prevents the former but not the latter
- The `--` separator is a simple, well-understood defense that should be standard practice

## Resources

- [Phase 0 plan, security section](docs/plans/2026-03-04-feat-phase-0-architecture-gate-plan.md) -- mentions control character hardening but not flag injection
- [Bun test CLI docs](https://bun.sh/docs/cli/test) -- documents `--preload`, `--bail`, and other flags
- [OWASP Command Injection](https://owasp.org/www-community/attacks/Command_Injection) -- general reference on argument injection vectors
- `packages/bun-runner/mcp/index.ts` -- affected spawn calls
