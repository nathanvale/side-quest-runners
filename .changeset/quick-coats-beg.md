---
'@side-quest/biome-runner': patch
'@side-quest/bun-runner': patch
'@side-quest/tsc-runner': patch
---

feat(runners): complete phase E parity and strengthen smoke validation

Complete cross-runner parity updates and harden integration safety:

- biome-runner: add `biome_lintFix` integration coverage and behavior refinements
- bun-runner: correct coverage invocation semantics and related test expectations
- tsc-runner: align runner behavior with cross-runner rollout requirements
- smoke harness: add cross-runner stdio sandbox checks and CI/validate integration

This release focuses on runner reliability and end-to-end validation confidence
across all three MCP runners.
