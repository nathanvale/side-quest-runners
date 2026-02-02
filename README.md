# side-quest-runners

MCP server runners for Claude Code. Run tests, lint, and typecheck with structured, token-efficient output.

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`@side-quest/bun-runner`](./packages/bun-runner) | Bun test runner MCP server | [![npm](https://img.shields.io/npm/v/@side-quest/bun-runner)](https://www.npmjs.com/package/@side-quest/bun-runner) |
| [`@side-quest/biome-runner`](./packages/biome-runner) | Biome linter & formatter MCP server | [![npm](https://img.shields.io/npm/v/@side-quest/biome-runner)](https://www.npmjs.com/package/@side-quest/biome-runner) |
| [`@side-quest/tsc-runner`](./packages/tsc-runner) | TypeScript type checker MCP server | [![npm](https://img.shields.io/npm/v/@side-quest/tsc-runner)](https://www.npmjs.com/package/@side-quest/tsc-runner) |

## Usage

Each package is a standalone MCP server. Run via `bunx`:

```bash
# Start a runner
bunx --bun @side-quest/bun-runner
bunx --bun @side-quest/biome-runner
bunx --bun @side-quest/tsc-runner
```

Or use with Claude Code plugins via `.mcp.json`:

```json
{
  "mcpServers": {
    "bun-runner": {
      "command": "bunx",
      "args": ["--bun", "@side-quest/bun-runner"]
    }
  }
}
```

## MCP Tools

### bun-runner
- `bun_runTests` — Run tests with optional pattern filter
- `bun_testFile` — Run specific test file
- `bun_testCoverage` — Run tests with coverage report

### biome-runner
- `biome_lintCheck` — Check for lint issues (read-only)
- `biome_lintFix` — Auto-fix lint and formatting issues
- `biome_formatCheck` — Check formatting (read-only)

### tsc-runner
- `tsc_check` — Run TypeScript type checking

## Development

```bash
bun install
bun run build
bun run test
bun run typecheck
bun run validate   # Full quality check
```

## License

MIT
