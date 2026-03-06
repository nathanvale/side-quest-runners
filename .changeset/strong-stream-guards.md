---
'@side-quest/biome-runner': patch
'@side-quest/bun-runner': patch
'@side-quest/tsc-runner': patch
---

Harden subprocess output handling to prevent out-of-memory failures on large command output.

- Replace unbounded `Response(...).text()` reads with bounded stream collectors in all runners.
- Add explicit truncation detection and safe `SPAWN_FAILURE` errors when output exceeds capture limits.
- Add truncation regression tests for biome-runner and bun-runner spawn helpers.
- Add Biome-side output reduction with `--max-diagnostics=200` to reduce reporter JSON volume at source.

This fixes the OOM failure mode reported in issue #42 and applies the same guardrail pattern consistently across biome, bun, and tsc runners.
