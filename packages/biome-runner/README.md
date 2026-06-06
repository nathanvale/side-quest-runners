# @side-quest/biome-runner

Biome linter & formatter MCP server for Claude Code. Structured diagnostics with auto-fix support.

## Tools

- `biome_lintCheck` — Check for lint issues (read-only)
- `biome_lintFix` — Auto-fix lint and formatting issues
- `biome_formatCheck` — Check formatting (read-only)

## Usage

```bash
bunx --bun @side-quest/biome-runner
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "biome-runner": {
      "command": "bunx",
      "args": ["--bun", "@side-quest/biome-runner"]
    }
  }
}
```

## Response Format

All tools accept a `response_format` parameter (`"markdown"` or `"json"`). Use `"json"` for token-efficient structured output in agent pipelines.

JSON responses include `cwd`, the worktree root used to run Biome. Inspect it
when passing absolute paths from Codex or other Git worktrees.

## Git Worktrees

The runner accepts paths in the startup checkout and linked Git worktrees that
share the same Git common dir. Unrelated repositories remain blocked.

```json
{
  "path": "/path/to/codex-worktree/src/index.ts",
  "response_format": "json"
}
```

## License

MIT
