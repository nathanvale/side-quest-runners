---
'@side-quest/biome-runner': patch
'@side-quest/bun-runner': patch
'@side-quest/tsc-runner': patch
---

feat(runners): publish unpublished phase A-E runner improvements

This release captures the runner changes since the last package publish:

- phase A: migrate runners to `@modelcontextprotocol/sdk@1.27.1`
- phase B/C/D: improve tsc-runner contract, reliability, and observability behavior
- phase E: complete cross-runner parity updates and follow-up fixes
- smoke hardening: add cross-runner stdio sandbox checks and CI/validate integration

This release focuses on runner reliability and end-to-end validation confidence
across all three MCP runners.
