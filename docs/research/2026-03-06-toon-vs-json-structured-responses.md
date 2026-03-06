---
title: "Arena: TOON for MCP Tool Responses vs Stay with JSON"
type: research
status: complete
date: 2026-03-06
method: adversarial arena research (2 parallel beat reporters + judge synthesis)
sources: [reddit, x-twitter, web, local-spike]
tags: [arena, toon, json, token-efficiency, mcp, structured-content]
---

# Arena: TOON for MCP Tool Responses vs Stay with JSON

## Summary

Investigated whether TOON (Token-Oriented Object Notation) should replace JSON for
MCP tool structured responses to reduce context window consumption. Ran adversarial
research with biased pro/anti teams, then validated with a local spike against real
runner output. **Verdict: Team B (Stay with JSON) wins 16/25 to 15/25**, but the
margin is narrow and TOON remains viable for a future iteration after simpler
optimizations are exhausted.

## Key Findings

1. **TOON savings are real but narrow**: 40% fewer tokens vs compact JSON on flat
   tabular data (the exact shape our runners produce). 58.8% on formatted JSON.
   But nested/irregular data sees much smaller gains.

2. **Our runners hit TOON's sweet spot**: biome diagnostics (6 keys x N items),
   tsc errors (5 keys x N), bun failures (4 keys x N) are all uniform arrays --
   exactly what TOON is designed for.

3. **MCP protocol constraint**: `structuredContent` must be JSON per the MCP spec.
   TOON can only affect `content[].text` -- the human-readable text representation.

4. **Hook duplication is the bigger problem**: Biome-ci and bun-test-ci hooks inject
   structured JSON into context that overlaps with the MCP tool response. Same errors
   appear twice in different formats.

5. **Simpler wins available first**: Stripping null fields, deduplicating file paths,
   truncating stack traces, and fixing hook/response overlap would save comparable
   tokens without a new dependency.

6. **TOON ecosystem is growing**: 23k GitHub stars, v3.0 spec, implementations in
   25+ languages. MCP spec team confirmed TOON works in TextContent blocks today
   (issue #1798 closed as COMPLETED).

## Round-by-Round Scoring

### Round 1: Hard Data

- Team A (Pro-TOON): 4/5 -- Real benchmarks across 4 frontier models. 76.4% accuracy
  vs JSON's 75.0%. Independently replicated.
- Team B (Anti-TOON): 3/5 -- Benchmarks skew toward TOON's ideal case. Weak models
  may burn more tokens with TOON (paper citation via @vista8).

### Round 2: Production Proof

- Team A: 2/5 -- One Italian Reddit user, PHP 10k downloads. No named company at scale.
- Team B: 4/5 -- Cloudflare reduced 2.5M tokens to 1k via architecture, not format
  swaps (1,055 likes). SDL-MCP claims 70%+ savings with plain JSON optimization.

### Round 3: Ecosystem Momentum

- Team A: 4/5 -- 23k stars, v3.0 spec, 25+ language implementations, MCP greenlit.
- Team B: 2/5 -- "Yet another format" argument didn't land strongly in the data.

### Round 4: Developer Experience

- Team A: 2/5 -- Simple API but no debugging ergonomics evidence.
- Team B: 4/5 -- Holter's "wide rows cause positional brittleness." No IDE tooling,
  no syntax highlighting. 20-30% more debugging time during adoption.

### Round 5: Future Trajectory

- Team A: 3/5 -- Growing fast, MCP-compatible today.
- Team B: 3/5 -- Context windows growing, simpler alternatives proven.

### Final Score

| Team | R1 | R2 | R3 | R4 | R5 | Total |
|------|----|----|----|----|----|----|
| Team A (Pro-TOON) | 4 | 2 | 4 | 2 | 3 | 15/25 |
| Team B (Anti-TOON) | 3 | 4 | 2 | 4 | 3 | 16/25 |

## Local Spike Results

Ran all three MCP tools against intentional error files in `tmp-spike/`:

### bun_testFile (7 failures)

- 7 failure objects with `file`, `message`, `line`, `stack` (4 keys x 7 = 28 repeated keys)
- `file` value identical across all 7 (same test file) -- pure redundancy
- Stack traces are multi-line async boilerplate

### biome_lintCheck (11 diagnostics)

- 11 objects with `file`, `line`, `message`, `code`, `severity`, `suggestion` (6 keys x 11 = 66 repeated keys)
- `file` identical across all 11
- `suggestion: null` repeated 11 times -- pure waste
- `severity` repeats `"warning"` 7 times and `"error"` 4 times

### biome_formatCheck

- Tiny response: `{"formatted":false,"unformattedFiles":["..."]}` -- not worth optimizing

### Hook responses (also enter context)

- **biome-ci hook**: 20 diagnostic objects -- overlapping with MCP tool response
- **bun-test-ci hook**: 30+ lines of pass/fail output as string array

## Recommended Action Plan

### Phase 1: Zero-dependency wins (do first)

1. **Strip null fields** from structured output (e.g. `suggestion: null`)
2. **Truncate stack traces** to top frame only in text output
3. **Deduplicate file path** when all items in an array share the same file
4. **Audit hook vs MCP overlap** -- same errors shouldn't appear twice in context

### Phase 2: Evaluate TOON (after Phase 1)

1. Add `'toon'` as a third `response_format` option (alongside `'json'` and `'markdown'`)
2. TOON-encode `content[].text` only -- `structuredContent` stays JSON
3. Measure actual token savings on real-world payloads post-Phase 1 cleanup

## Sources

### Team A (Pro-TOON)

- [toon-format/toon - GitHub (23k+ stars)](https://github.com/toon-format/toon)
- [MCP Feature Request #1798 - TOON support (closed: already works)](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1798)
- [toon-mcp: MCP server for TOON (GitHub)](https://github.com/copyleftdev/toon-mcp)
- [InfoQ: New TOON Format Hopes to Cut LLM Costs (Nov 2025)](https://www.infoq.com/news/2025/11/toon-reduce-llm-cost-tokens/)
- [freeCodeCamp: What Is TOON](https://www.freecodecamp.org/news/what-is-toon-how-token-oriented-object-notation-could-change-how-ai-sees-data/)
- [@wevm_dev: "up to 3x fewer tokens per session" (Feb 27)](https://x.com/wevm_dev/status/2027462087166103796)
- [@deepfates: JSON tool-calling critique (328 likes)](https://x.com/deepfates/status/2025134281346220523)
- [r/IA_Italia: Qualcuno utilizza TOON al posto di JSON?](https://www.reddit.com/r/IA_Italia/comments/1rbgzga/qualcuno_utilizza_toon_al_posto_di_json/)

### Team B (Anti-TOON)

- [Adam Holter: TOON vs JSON - Where It Actually Helps](https://adam.holter.com/toon-vs-json-for-llms-token-efficiency-retrieval-accuracy-and-where-it-actually-helps/)
- [Architecture & Governance: TOON for Enterprise LLM Integration](https://www.architectureandgovernance.com/applications-technology/token-economics-and-serialisation-strategy-evaluating-toon-for-enterprise-llm-integration/)
- [Chroma Research: Context Rot](https://research.trychroma.com/context-rot)
- [MCP Issue 1710: configurable response format](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1710)
- [@Cloudflare: 2.5M to 1k tokens via architecture (1,055 likes)](https://x.com/Cloudflare/status/2024847784914882945)
- [r/mcp: MCP proxy that saves tokens (score 73)](https://www.reddit.com/r/mcp/comments/1rfq3t3/mcp_proxy_that_saves_tokens/)
- [TensorLake: TOON vs JSON benchmarks and caveats](https://tensorlake.ai/blog/toon-vs-json)

## Open Questions

1. How much context do the hooks consume vs the MCP tool responses? Need to measure
   the overlap precisely to know if deduplication is the bigger win.
2. Does Claude Code actually read `structuredContent` into context, or only
   `content[].text`? If only text, the TOON opportunity is smaller than it appears.
3. Would a TOON `response_format` confuse downstream MCP clients that expect JSON
   in the text field?
4. The @vista8 claim about weaker models burning more tokens with TOON -- is this
   reproducible? Matters for users on smaller models.
