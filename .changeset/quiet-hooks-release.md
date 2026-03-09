---
'@side-quest/claude-hooks': minor
---

Publish the first public release of `@side-quest/claude-hooks`.

- Add the Claude hook adapter package with a single `sq-claude-hook` CLI.
- Harden dedup behavior for `PostToolUse` and `PostToolUseFailure` handling.
- Add bounded stdin parsing, safer cache handling, and stderr-only observability.
- Add regression coverage, smoke coverage, and release-ready build/test/typecheck support.
