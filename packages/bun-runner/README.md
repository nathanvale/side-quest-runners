# @side-quest/bun-runner

Bun test runner MCP server for Claude Code. Runs tests with structured, token-efficient output.

## Tools

- `bun_runTests` — Run tests with optional `pattern` and `cwd`
- `bun_testFile` — Run specific test file
- `bun_testCoverage` — Run tests with coverage report and optional `cwd`

## Usage

```bash
bunx --bun @side-quest/bun-runner
```

Or in `.mcp.json`:

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

## Response Format

All tools accept a `response_format` parameter (`"markdown"` or `"json"`). Use `"json"` for token-efficient structured output in agent pipelines.

JSON responses include `cwd`, the directory used to run Bun. Inspect it when
calling from Codex or other Git worktrees.

## Git Worktrees

The runner accepts paths in the startup checkout and linked Git worktrees that
share the same Git common dir. Unrelated repositories remain blocked.

```json
{
  "cwd": "/path/to/codex-worktree",
  "response_format": "json"
}
```

## License

MIT
