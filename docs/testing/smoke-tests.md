# Cross-Runner Smoke Tests

Use smoke tests to validate real MCP stdio behavior for all three runners in
isolated temporary sandboxes.

## Run

```bash
bun run test:smoke
```

## What It Covers

1. `tsc-runner`
2. `bun-runner`
3. `biome-runner`

For each runner the smoke harness:

1. Creates a fresh sandbox under `reports/smoke-sandboxes/`.
2. Spawns the runner with `bun <runner>/mcp/index.ts` over stdio.
3. Connects with an MCP client and runs representative tool calls.
4. Verifies tool discovery (`tools/list`) and output contract shape.
5. Verifies core behavior for passing and failing scenarios.

## Keep Sandboxes For Debugging

By default, sandboxes are deleted after the run.

Set this environment variable to keep them:

```bash
SMOKE_KEEP_SANDBOXES=1 bun run test:smoke
```
