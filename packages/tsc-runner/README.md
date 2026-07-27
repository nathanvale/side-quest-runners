# @side-quest/tsc-runner

TypeScript type checker MCP server for Claude Code. Structured diagnostics with tsconfig auto-detection.

## Tools

- `tsc_check` — Run TypeScript type checking using nearest tsconfig/jsconfig

## Usage

```bash
bunx --bun @side-quest/tsc-runner
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "tsc-runner": {
      "command": "bunx",
      "args": ["--bun", "@side-quest/tsc-runner"]
    }
  }
}
```

## Response Format

All tools accept a `response_format` parameter (`"markdown"` or `"json"`). Use `"json"` for token-efficient structured output in agent pipelines.

JSON responses include `cwd`, the directory used to run TypeScript from the
nearest config. Inspect it when passing absolute paths from Codex or other Git
worktrees.

## Git Worktrees

The runner accepts paths in the startup checkout and linked Git worktrees that
share the same Git common dir. Config discovery stays bounded to the selected
worktree, and unrelated repositories remain blocked.

```json
{
  "path": "/path/to/codex-worktree/packages/app/src/index.ts",
  "response_format": "json"
}
```

## License

MIT
