---
"@side-quest/biome-runner": major
"@side-quest/bun-runner": major
"@side-quest/tsc-runner": major
---

Add default-on idle shutdown for retained MCP runner processes.

Runners now exit after 15 minutes without tool activity even when an app host
keeps the parent process and stdio pipes alive. The timeout is configurable via
`MCP_IDLE_EXIT_MS`, with `0` disabling the idle shutdown backstop.

Breaking change: retained clients that relied on an idle runner staying alive
indefinitely should set `MCP_IDLE_EXIT_MS=0` to preserve the previous behavior.
