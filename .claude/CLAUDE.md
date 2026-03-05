# side-quest-runners

MCP server runners for Claude Code -- bun test, biome lint/format, tsc typecheck.

**Stack:** TypeScript, Bun, Biome, Changesets

---

## Commands

```bash
# Quality
bun run check            # Biome lint + format (write mode)
bun run lint             # Biome lint only
bun run typecheck        # TypeScript type checking (all packages)
bun run validate         # Full gate: lint + typecheck + build + test + smoke

# Testing
bun test                 # Run all package tests (bun:test)
bun test:smoke           # Smoke tests (subprocess stdio transport)
bun test:ci              # Tests with TF_BUILD=true (CI-style output)
bun test:coverage        # Tests with coverage

# Build
bun run build            # Build all packages (bunup)
bun run clean            # Clean all dist/ directories

# Single package
bun run --filter bun-runner test
bun run --filter biome-runner build
bun run --filter tsc-runner typecheck

# Releases
bun run version:pre      # Create changeset version bump
bun run release          # Publish with provenance
```

---

## Architecture

Bun workspace monorepo with 3 independent packages under `packages/`:

```text
packages/
  biome-runner/    @side-quest/biome-runner  - Biome lint + format diagnostics
  bun-runner/      @side-quest/bun-runner    - Bun test runner
  tsc-runner/      @side-quest/tsc-runner    - TypeScript type checker
```

Each package is a **single-file MCP server** (~1000 lines) at `mcp/index.ts`. No shared utility package -- each server is fully self-contained.

### MCP Server Pattern

Every server follows the same structure:

1. **Factory function** -- `createXServer()` returns a configured `McpServer` instance (used by tests)
2. **Stdio entry** -- `startXServer()` connects via `StdioServerTransport`
3. **Entry guard** -- `if (import.meta.main) { void startXServer() }`

```text
mcp/index.ts        # Server implementation (~1000 lines)
mcp/index.test.ts   # Co-located tests
```

---

## Test Architecture

Uses **Bun's built-in test runner** (`bun:test`), NOT Vitest.

Tests are co-located at `mcp/index.test.ts` with three tiers:

1. **Unit tests** -- pure functions (parsers, formatters, validators)
2. **Integration tests** -- full MCP round-trips via `InMemoryTransport` (calls `createXServer()`)
3. **Smoke tests** -- subprocess via `StdioClientTransport` (validates the built binary works end-to-end)

Smoke tests live at `scripts/smoke/run-smoke.ts` and run via `bun test:smoke`.

---

## Key Patterns

- **Structured output** -- tools return both `content` (text) and `structuredContent` (JSON), with `response_format` parameter for caller preference
- **Path validation** -- security boundary that rejects path traversal and symlink escapes
- **`spawnWithTimeout`** -- child process execution with configurable timeout, SIGTERM then SIGKILL escalation
- **LogTape fingersCrossed** -- observability handler that buffers debug logs and flushes on error

---

## Code Conventions

| Area | Convention |
|------|------------|
| Files | kebab-case (`my-util.ts`) |
| Functions | camelCase (`doSomething`) |
| Types | PascalCase (`MyType`) |
| Exports | Named only (no defaults) |
| Formatting | Biome (tabs, single quotes, 80-char) |

---

## Git Workflow

**Branch pattern:** `type/description` (e.g., `feat/add-feature`, `fix/bug-fix`)

**Commit format:** Conventional Commits (enforced by commitlint)

```text
feat(scope): add new feature
fix(scope): fix bug
chore(deps): update dependencies
```

**Before pushing:** Always run `bun run validate`

---

## CI/CD Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `pr-quality.yml` | PR | Lint, types, tests, smoke |
| `commitlint.yml` | PR | Validate commit messages |
| `workflow-lint.yml` | PR | Lint GitHub Actions workflows |
| `package-hygiene.yml` | PR | publint, attw, pack dry-run |
| `node-compat.yml` | PR | Verify Node.js compatibility |
| `publish.yml` | Push to main | Version packages PR |
| `release.yml` | Push to main | Publish to npm with provenance |
| `security.yml` | Schedule/PR | CodeQL + dependency review |

---

## Publishing

Uses **Changesets** for versioning and **OIDC Trusted Publishing** for npm releases.

1. Create a changeset: `bun run version:pre`
2. Push to main -- CI creates a "Version Packages" PR
3. Merge the PR -- CI publishes with `--provenance` via GitHub OIDC

---

## Special Rules

### ALWAYS

1. Run `bun run validate` before pushing
2. Create changesets for user-facing changes
3. Use named exports (no defaults)

### NEVER

1. Push directly to main (pre-push hook blocks)
2. Skip validation before commits
3. Use destructive git commands (`reset --hard`, `push --force`)
4. Create nested `biome.json` files -- monorepo uses single root config
