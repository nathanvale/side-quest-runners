---
'@side-quest/bun-runner': patch
'@side-quest/biome-runner': patch
'@side-quest/tsc-runner': patch
---

Make idle shutdown opt-in so deferred MCP tools stay available during long
agent sessions unless hosts set `MCP_IDLE_EXIT_MS`.
