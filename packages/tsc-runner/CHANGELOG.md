# @side-quest/tsc-runner

## 1.0.3

### Patch Changes

- [#40](https://github.com/nathanvale/side-quest-runners/pull/40) [`e88bb1d`](https://github.com/nathanvale/side-quest-runners/commit/e88bb1d95a39f3b03cacddfa42f733abcad1fc87) Thanks [@nathanvale](https://github.com/nathanvale)! - feat(runners): publish unpublished phase A-E runner improvements

  This release captures the runner changes since the last package publish:

  - phase A: migrate runners to `@modelcontextprotocol/sdk@1.27.1`
  - phase B/C/D: improve tsc-runner contract, reliability, and observability behavior
  - phase E: complete cross-runner parity updates and follow-up fixes
  - smoke hardening: add cross-runner stdio sandbox checks and CI/validate integration

  This release focuses on runner reliability and end-to-end validation confidence
  across all three MCP runners.

## 1.0.2

### Patch Changes

- Fix import.meta.main being transformed to \_\_require by adding target: 'bun' to bunup config

  The bunup bundler was transforming `import.meta.main` into CommonJS-style `__require.main == __require.module`, but the output format is ESM where `__require` doesn't exist. Adding `target: 'bun'` preserves Bun-specific features and adds the `// @bun` pragma.

## 1.0.1

### Patch Changes

- [#2](https://github.com/nathanvale/side-quest-runners/pull/2) [`429c007`](https://github.com/nathanvale/side-quest-runners/commit/429c00757913f8caa1c15b3a2fd4a7995926b92d) Thanks [@nathanvale](https://github.com/nathanvale)! - Document response_format parameter in README files

## 1.0.0

### Major Changes

- Initial release of MCP server runner packages extracted from side-quest-marketplace.

  - @side-quest/bun-runner: Test execution with bun_runTests, bun_testFile, bun_testCoverage
  - @side-quest/biome-runner: Lint & format with biome_lintCheck, biome_lintFix, biome_formatCheck
  - @side-quest/tsc-runner: Type checking with tsc_check

## 0.0.0

Initial development version. See [README](./README.md) for details.
