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

## License

MIT
