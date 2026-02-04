---
'@side-quest/bun-runner': patch
---

Fix console.error false positive in bun_runTests parser. Tests emitting console.error output as part of expected behavior no longer create spurious failures when the summary line shows 0 fail.
