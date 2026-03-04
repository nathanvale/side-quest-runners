---
status: pending
priority: p2
issue_id: "015"
tags: [code-review, security, reliability]
dependencies: []
---

# Add SIGKILL escalation after SIGTERM timeout

## Problem Statement

When a subprocess times out, only SIGTERM is sent. A malicious or stuck process that traps/ignores SIGTERM continues running indefinitely, leading to zombie processes and resource exhaustion.

## Findings

1. **Security sentinel (Finding 5):** SIGTERM can be caught and ignored; no SIGKILL fallback
2. **Performance oracle:** Confirmed -- ineffective timeout means MCP call hangs indefinitely

## Proposed Solutions

### Option A: Add SIGKILL after 5s grace period (Recommended)

```typescript
const timeout = setTimeout(() => {
    timedOut = true
    proc.kill('SIGTERM')
    setTimeout(() => {
        try { proc.kill('SIGKILL') } catch {}
    }, 5_000)
}, timeoutMs)
```

- **Pros:** Guarantees process termination, simple implementation
- **Cons:** 5s additional worst-case latency beyond timeout
- **Effort:** Small
- **Risk:** Low

## Technical Details

**Affected files:**
- `packages/tsc-runner/mcp/index.ts` lines 290-293 (`spawnWithTimeout`)
- `packages/biome-runner/mcp/index.ts` lines 241-244 (`spawnAndCollect`)
- `packages/bun-runner/mcp/index.ts` lines 205-208 (`spawnWithTimeout`)

## Acceptance Criteria

- [ ] All spawn helpers send SIGKILL after grace period if SIGTERM fails
- [ ] SIGKILL timer is cleared on normal process exit
- [ ] All 3 runners updated consistently

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-04 | Created from code review | Security + performance reviewers |
