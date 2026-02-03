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

## License

MIT
