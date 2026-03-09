# @side-quest/claude-hooks

Claude Code hook adapter for deduplicating runner diagnostics with MCP output.

## Usage

```bash
sq-claude-hook pretool
sq-claude-hook posttool
sq-claude-hook posttool-failure
```

## Environment

- `SQ_HOOK_DEDUP_ENABLED`: `1` enables dedup behavior (`0` by default)
- `SQ_HOOK_EVENT_TTL_MS`: dedup TTL in milliseconds (default `60000`)
- `HOOK_STDIN_MAX_BYTES`: maximum stdin payload size (default `4194304`)

## License

MIT
