# @side-quest/bun-runner

Bun test runner MCP server for Claude Code. Runs tests with structured, token-efficient output.

## Tools

- `bun_runTests` — Run tests with optional pattern filter
- `bun_testFile` — Run specific test file
- `bun_testCoverage` — Run tests with coverage report

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

## License

MIT
