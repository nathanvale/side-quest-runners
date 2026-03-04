---
review_agents:
  - kieran-typescript-reviewer
  - security-sentinel
  - performance-oracle
  - architecture-strategist
  - code-simplicity-reviewer
  - pattern-recognition-specialist
  - agent-native-reviewer
---

## Project Context

TypeScript/Bun monorepo with 3 MCP runner packages (tsc-runner, bun-runner, biome-runner).
Uses Biome for linting/formatting, Vitest for testing, Changesets for releases.
All runners are MCP servers consumed by AI agents (Claude Code).
