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

## License

MIT
