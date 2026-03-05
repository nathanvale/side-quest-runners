---
'@side-quest/biome-runner': patch
'@side-quest/bun-runner': patch
'@side-quest/tsc-runner': patch
---

fix(runners): stabilize smoke sandbox behavior and tighten smoke assertions

Keep smoke sandboxes in a repo-local ignored path for runner path validation,
exclude that path from Bun test discovery, and harden smoke checks/docs around
post-fix formatting assertions and contributor guidance.
