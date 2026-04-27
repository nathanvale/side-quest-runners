---
'@side-quest/bun-runner': patch
'@side-quest/biome-runner': patch
'@side-quest/tsc-runner': patch
---

Add parent-liveness watcher so MCP runners exit promptly when their parent Claude Code session (or sub-agent) dies without delivering SIGTERM. Previously, runners were reparented to PID 1 and persisted indefinitely, accumulating dozens of orphaned `bun` processes across a workday.

The watcher polls `process.ppid` every 5 seconds and triggers the existing graceful shutdown path when the parent disappears. The poll interval is configurable via the `MCP_PARENT_CHECK_MS` environment variable (set to `0` to disable; minimum effective value is 50ms).
