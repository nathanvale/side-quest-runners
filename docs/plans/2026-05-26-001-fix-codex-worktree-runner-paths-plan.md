---
title: "fix: Accept Codex Git worktree paths in MCP runners"
type: fix
status: completed
date: 2026-05-26
origin: https://github.com/nathanvale/side-quest-runners/issues/71
---

# fix: Accept Codex Git worktree paths in MCP runners

## Summary

Teach the Bun, Biome, and TypeScript MCP runners to treat linked Git
worktrees of the configured repository as valid execution roots. Path-bearing
tools should infer the target checkout from the input path, suite-level tools
should expose an explicit `cwd`, and JSON outputs should include the resolved
execution cwd so agents can verify they used the active Codex worktree.

---

## Problem Frame

Issue #71 reports that runner MCP tools reject absolute paths under
Codex-created worktrees as `Path outside repository`, even when those paths are
valid linked worktrees for the same repository. The current validators cache
the server startup Git root and only accept real paths under that one checkout,
which pushes agents back to raw repo CLIs and loses the runners' structured,
token-efficient output.

---

## Requirements

- R1. Accept absolute file or directory paths inside linked Git worktrees that
  share the configured repository's Git common dir.
- R2. Preserve traversal, null-byte, control-character, and symlink escape
  protections for all path inputs.
- R3. Resolve the execution cwd from the target worktree for tools that receive
  a file or path input.
- R4. Add an explicit `cwd` input for suite-level tools that otherwise have no
  path from which to infer the active checkout.
- R5. Include the resolved execution cwd in JSON structured output for all
  runner tool calls.
- R6. Keep backward compatibility for callers that omit `cwd` or pass paths in
  the server startup checkout.
- R7. Reject unrelated repositories and arbitrary filesystem paths with a
  diagnostic that names the configured runner boundary.
- R8. Cover the behavior across `bun-runner`, `biome-runner`, and `tsc-runner`
  with unit and smoke coverage.

---

## Scope Boundaries

- Do not turn the runners into arbitrary cross-repository command executors.
  This plan accepts the startup checkout and linked worktrees for the same Git
  common dir.
- Do not introduce a shared package as part of this fix. The current repo still
  keeps each runner self-contained; a later runner-core refactor may consolidate
  the duplicated helper once behavior is proven.
- Do not change MCP tool names or remove existing inputs.
- Do not change parser semantics, diagnostic filtering, timeout policy, idle
  shutdown behavior, or parent-liveness behavior.
- Do not require Codex-specific environment variables or filesystem layout.

### Deferred to Follow-Up Work

- Move the new path-boundary helper into `runner-core` if the active runner CLI
  primitive convergence plan lands first or resumes later.
- Consider a broader "trusted extra roots" configuration only if a future issue
  asks runners to operate across unrelated repositories.

---

## Context & Research

### Relevant Code and Patterns

- `packages/bun-runner/mcp/index.ts` caches `getGitRoot()` from process startup,
  validates `bun_testFile.file`, validates path-like `bun_runTests.pattern`
  values, and runs `bun test` from process cwd today.
- `packages/biome-runner/mcp/index.ts` validates optional `path` inputs and
  passes absolute target paths to Biome while spawning from process cwd.
- `packages/tsc-runner/mcp/index.ts` validates optional `path`, then
  `resolveWorkdir()` and `findNearestTsConfig()` stay bounded to the startup
  Git root.
- All three runners use realpath-based validation and `resolveNearestAncestor()`
  to avoid missing symlink escapes for non-existent paths.
- `scripts/smoke/run-smoke.ts` already builds production runner binaries and
  has cross-runner smoke helpers for subprocess lifecycle tests.
- Existing successful `tsc_check` output already includes `cwd`, which is the
  right verification signal to extend across the runner tools.

### Institutional Learnings

- `docs/solutions/integration-issues/mcp-tool-discoverability-ab-benchmark.md`
  treats MCP tool contracts as behavior that needs live validation, not just
  compact schemas. This fix changes routing-relevant schema text and structured
  output, so smoke coverage should prove agents can target the right runner.
- `docs/plans/2026-05-18-001-refactor-runner-cli-primitive-convergence-plan.md`
  identifies path validation as repeated runner primitive code, but that plan
  is broader than issue #71. This bug should be fixed narrowly first unless
  that refactor has already landed when implementation starts.

### External References

- Git worktrees expose a distinct worktree root while sharing a common Git dir
  with the main checkout. `git rev-parse --show-toplevel` identifies the active
  worktree root, and `git rev-parse --path-format=absolute --git-common-dir`
  identifies the underlying repository store used to compare linked worktrees.

---

## Key Technical Decisions

- **Use Git common dir as the trust boundary:** Compare the target path's
  nearest Git common dir with the server startup common dir. This accepts Codex
  worktrees for the same repo without opening the runner to unrelated repos.
- **Return a path context, not just a string:** Replace plain `validatePath()`
  internals with a helper that returns the canonical path, target worktree root,
  startup root, and selected execution cwd. Keep exported `validatePath()`
  returning a string where existing tests or callers depend on it.
- **Preserve realpath-first safety:** Continue resolving the input path or
  nearest existing ancestor through `realpath()` before deciding whether it is
  inside an allowed worktree.
- **Infer cwd from path-bearing inputs:** `bun_testFile`, Biome `path` tools,
  and `tsc_check.path` should run from the worktree/config root associated with
  the validated path, not from the runner server's process cwd.
- **Add `cwd` only where inference is impossible:** Add `cwd` to
  `bun_runTests` and `bun_testCoverage`; allow Biome and TSC callers to use
  their existing `path` argument as the worktree selector.
- **Make mixed path/cwd inputs strict:** When a tool receives both a target path
  and `cwd`, both must resolve inside the same allowed worktree. Reject
  mismatches rather than silently running one checkout against another.
- **Expose cwd without wrapping every response in a new envelope:** Add a
  `cwd` field to each structured output schema. For nested outputs such as
  Biome fix results, add it at the top level beside the existing result fields.

---

## Open Questions

### Resolved During Planning

- **Should unrelated repos be accepted if callers pass an absolute path?** No.
  The bug is about linked worktrees of the configured repo. Expanding to
  unrelated repos would change the runner security model.
- **Should this wait for runner-core extraction?** No. Issue #71 blocks the
  current published runners. Keep the fix local and duplicated, then extract
  later if the convergence plan proceeds.
- **Should Biome and TSC receive new `cwd` inputs?** Not initially. Their
  existing `path` inputs already identify the target checkout. Add `cwd` later
  only if implementation finds a real suite-level gap.

### Deferred to Implementation

- **Exact helper names:** Let the implementing agent choose names that fit each
  file, as long as the helper returns canonical path and target root context.
- **Output text wording:** JSON shape must include `cwd`; markdown summaries can
  add cwd where concise, but exact prose should follow existing formatter style.

---

## Implementation Units

### U1. Add worktree-aware path context resolution

**Goal:** Replace startup-root-only validation with a reusable local helper that
accepts the startup checkout plus linked worktrees sharing the same Git common
dir.

**Requirements:** R1, R2, R6, R7

**Dependencies:** None

**Files:**
- Modify: `packages/bun-runner/mcp/index.ts`
- Modify: `packages/biome-runner/mcp/index.ts`
- Modify: `packages/tsc-runner/mcp/index.ts`
- Test: `packages/bun-runner/mcp/index.test.ts`
- Test: `packages/biome-runner/mcp/index.test.ts`
- Test: `packages/tsc-runner/mcp/index.test.ts`

**Approach:**
- Keep the current input checks for null bytes, control characters, blank
  paths, and nearest-existing-ancestor realpath fallback.
- Add startup repository context caching: startup worktree root plus absolute
  startup Git common dir.
- Resolve target repository context with `git -C <nearest-real-dir>
  rev-parse --show-toplevel` and `git -C <nearest-real-dir> rev-parse
  --path-format=absolute --git-common-dir`.
- Accept the path when the real input is inside the startup root, or when the
  target common dir matches the startup common dir and the real input is inside
  the target worktree root.
- Reject paths outside those roots with a clearer message such as
  `Path outside configured runner repository or linked worktrees: <path>`.
- Preserve `_resetGitRootCache()` behavior in tests, expanding it to reset the
  new repository-context cache.

**Execution note:** Add characterization coverage before changing each runner's
validation helper so symlink and traversal protections stay locked.

**Patterns to follow:**
- Existing `validatePath()`, `resolveNearestAncestor()`, and
  `_resetGitRootCache()` in each runner.
- Existing symlink escape tests in `biome-runner` and `tsc-runner`; add the
  missing Bun counterpart while touching the helper.

**Test scenarios:**
- Happy path: path in the startup checkout validates to its real path.
- Happy path: path in a temporary linked worktree created with `git worktree
  add --detach` validates and reports the linked worktree root.
- Edge case: non-existent path under a linked worktree validates through the
  nearest existing ancestor without losing the target worktree root.
- Error path: path in an unrelated temporary Git repo is rejected with the
  configured-runner-boundary diagnostic.
- Error path: traversal such as `../../../etc/passwd` remains rejected.
- Error path: symlink inside an allowed worktree pointing to `/tmp` remains
  rejected.
- Error path: null-byte and control-character inputs remain rejected.

**Verification:**
- Focused runner tests prove old protections and new linked-worktree acceptance
  in all three packages.

---

### U2. Run path-bearing tools from the resolved target checkout

**Goal:** Ensure file/path tools execute against the checkout identified by the
validated input path, so configs, dependencies, and output cwd match the active
worktree.

**Requirements:** R1, R3, R5, R6, R8

**Dependencies:** U1

**Files:**
- Modify: `packages/bun-runner/mcp/index.ts`
- Modify: `packages/biome-runner/mcp/index.ts`
- Modify: `packages/tsc-runner/mcp/index.ts`
- Test: `packages/bun-runner/mcp/index.test.ts`
- Test: `packages/biome-runner/mcp/index.test.ts`
- Test: `packages/tsc-runner/mcp/index.test.ts`

**Approach:**
- For `bun_testFile`, validate the file and run `bun test -- <validated-file>`
  with spawn `cwd` set to the target worktree root.
- For `bun_runTests` with a path-like `pattern`, validate the path and run from
  that target worktree root. Preserve name-only pattern behavior by running
  from the selected/default cwd.
- For `biome_lintCheck`, `biome_lintFix`, and `biome_formatCheck`, validate
  the target path and pass the target worktree root to `spawnWithTimeout()`.
- For `tsc_check`, update `resolveWorkdir()` and `findNearestTsConfig()` so the
  upward tsconfig search is bounded by the target worktree root instead of the
  startup root.
- Add `cwd` to structured outputs for Bun and Biome tools. Preserve existing
  `tsc_check.cwd`, but ensure failure outputs use the resolved target cwd when
  path resolution succeeded before a later failure.

**Patterns to follow:**
- Existing `spawnWithTimeout(..., { cwd })` signatures in Biome and TSC.
- Existing `TscOutput.cwd` schema and markdown summary wording.
- Existing MCP integration tests using `InMemoryTransport`.

**Test scenarios:**
- Happy path: `bun_testFile` called with an absolute linked-worktree test file
  runs successfully and returns structured `cwd` for the linked worktree.
- Happy path: Biome path tools called with an absolute linked-worktree path run
  with structured `cwd` for the linked worktree.
- Happy path: `tsc_check` called with an absolute linked-worktree path resolves
  the nearest config inside that worktree and returns worktree `cwd`.
- Edge case: name-only `bun_runTests.pattern` without `cwd` still uses the
  startup checkout.
- Error path: `tsc_check` for a linked-worktree directory without a config
  returns `CONFIG_NOT_FOUND` bounded to that worktree, not the startup root.
- Integration: JSON content and `structuredContent` both expose the same
  resolved cwd where the tool supports JSON text output.

**Verification:**
- Focused integration tests show the command cwd and structured output cwd
  match the linked worktree for each runner.

---

### U3. Add explicit cwd inputs for Bun suite-level tools

**Goal:** Let agents pin the active worktree for Bun operations that do not
otherwise receive a path.

**Requirements:** R4, R5, R6, R8

**Dependencies:** U1, U2

**Files:**
- Modify: `packages/bun-runner/mcp/index.ts`
- Modify: `packages/bun-runner/mcp/index.test.ts`
- Modify: `packages/bun-runner/README.md`

**Approach:**
- Add optional `cwd` to `bun_runTests` and `bun_testCoverage` input schemas.
- Validate `cwd` with the same worktree-aware helper and run Bun from the
  resolved worktree root.
- When both `pattern` and `cwd` are supplied to `bun_runTests`, validate any
  path-like pattern and require it to belong to the same resolved worktree as
  `cwd`.
- Keep `cwd` optional and default to current startup-root behavior when omitted.
- Include the resolved cwd in structured output for both tools.

**Patterns to follow:**
- Existing optional `path` schema descriptions in Biome and TSC.
- Existing tool-description style: concise action, boundary, and sibling-tool
  guidance.

**Test scenarios:**
- Happy path: `bun_runTests` with `cwd` set to a linked worktree and a test-name
  pattern runs from that worktree and reports that cwd.
- Happy path: `bun_testCoverage` with `cwd` set to a linked worktree runs from
  that worktree and reports that cwd.
- Edge case: omitted `cwd` preserves existing startup-root execution.
- Error path: `cwd` in an unrelated Git repo is rejected.
- Error path: `cwd` in one worktree plus path-like `pattern` in another
  worktree is rejected as a mixed-checkout request.
- Contract: tool list schemas expose `cwd` with a concise description.

**Verification:**
- Bun runner integration tests cover `cwd` defaulting, linked worktree
  execution, and mixed-checkout rejection.

---

### U4. Update docs, changesets, and production smoke coverage

**Goal:** Prove the published runner binaries accept Codex-style linked
worktree paths and document the new cwd contract for callers.

**Requirements:** R1, R4, R5, R8

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `scripts/smoke/run-smoke.ts`
- Modify: `packages/bun-runner/README.md`
- Modify: `packages/biome-runner/README.md`
- Modify: `packages/tsc-runner/README.md`
- Create: `.changeset/<generated-name>.md`

**Approach:**
- Add a smoke case that creates a temporary linked worktree from the current
  repository, writes small runner-specific fixtures inside it, then invokes the
  built production runners from their package dirs using absolute worktree
  paths or Bun `cwd`.
- Assert each structured JSON result includes a `cwd` under the linked
  worktree, not the startup checkout.
- Keep the smoke fixture self-cleaning with `git worktree remove --force` in a
  `finally` block.
- Update READMEs to describe linked worktree support, the Bun `cwd` option, and
  the `cwd` field in JSON output.
- Add a patch changeset for `@side-quest/bun-runner`,
  `@side-quest/biome-runner`, and `@side-quest/tsc-runner`.

**Patterns to follow:**
- Existing production-binary smoke setup in `scripts/smoke/run-smoke.ts`.
- Existing package README tool sections.
- Existing `.changeset/idle-shutdown-retained-runners.md` format.

**Test scenarios:**
- Smoke: built `tsc-runner` accepts a linked-worktree project path and reports
  worktree cwd.
- Smoke: built `bun-runner` accepts `cwd` for a linked-worktree test fixture and
  reports worktree cwd.
- Smoke: built `biome-runner` accepts a linked-worktree path and reports
  worktree cwd.
- Cleanup: smoke removes the temporary worktree even when one runner assertion
  fails.

**Verification:**
- `bun_runTests` passes for the affected package tests.
- `biome_lintCheck` passes after edits.
- `tsc_check` passes.
- `bun run build` and `bun test:smoke` pass before handoff or PR.

---

## System-Wide Impact

- **Interaction graph:** All public MCP runner tools keep their names, but
  schema metadata and structured output grow a `cwd` signal. Bun suite-level
  tools also gain a new optional input.
- **Error propagation:** Path-boundary failures should still return tool errors.
  The message should distinguish "outside configured runner repo/worktrees"
  from generic spawn failures where practical.
- **State lifecycle risks:** Temporary Git worktrees in tests and smoke must be
  removed reliably to avoid dirty `.git/worktrees` metadata.
- **API surface parity:** `cwd` output should be present across Bun, Biome, and
  TSC JSON outputs so agents can verify execution roots consistently.
- **Integration coverage:** Unit tests prove helper boundaries; smoke tests
  prove built binaries work from package dirs against a linked worktree.
- **Unchanged invariants:** Existing traversal and symlink escape protections
  remain mandatory. Callers without `cwd` or linked-worktree paths should see
  unchanged behavior except for the additive `cwd` field.

---

## Risks & Dependencies

- **Risk: security boundary accidentally expands to arbitrary repos.**
  Mitigation: compare Git common dirs and add unrelated-repo rejection tests.
- **Risk: symlink escape regression while adding worktree acceptance.**
  Mitigation: keep realpath-first validation and add Bun symlink coverage to
  match Biome and TSC.
- **Risk: Git worktree smoke tests leave behind metadata after failure.**
  Mitigation: wrap creation/removal in `try/finally`; use detached worktrees
  with unique temporary directories.
- **Risk: output schema additions surprise strict consumers.**
  Mitigation: make fields additive, update output schemas and READMEs, and ship
  as patch changesets for all three packages.
- **Risk: Biome config discovery differs when passing absolute paths.**
  Mitigation: run Biome subprocesses with cwd set to the target worktree root
  while keeping validated absolute target paths.

---

## Documentation / Operational Notes

- Add README examples showing Codex worktree usage:
  `bun_runTests({ cwd: "/path/to/worktree", response_format: "json" })` and
  path-bearing tools with absolute worktree paths.
- Mention that `cwd` in JSON output is the verification field agents should
  inspect before trusting diagnostics.
- Include issue #71 in the changeset summary.

---

## Sources & References

- Related issue: [#71](https://github.com/nathanvale/side-quest-runners/issues/71)
- Related plan: `docs/plans/2026-05-18-001-refactor-runner-cli-primitive-convergence-plan.md`
- Related code: `packages/bun-runner/mcp/index.ts`
- Related code: `packages/biome-runner/mcp/index.ts`
- Related code: `packages/tsc-runner/mcp/index.ts`
- Related smoke harness: `scripts/smoke/run-smoke.ts`
