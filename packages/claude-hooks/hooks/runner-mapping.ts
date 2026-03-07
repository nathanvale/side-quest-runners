import type { RunnerKind, RunnerOperation } from './types'

export interface RunnerMapping {
	runnerKind: RunnerKind
	operation: RunnerOperation
}

/**
 * Infer runner family + operation from Claude MCP tool naming convention.
 */
export function inferRunnerMapping(toolName: string): RunnerMapping | null {
	switch (toolName) {
		case 'mcp__biome-runner__biome_lintCheck':
			return { runnerKind: 'biome', operation: 'lintCheck' }
		case 'mcp__biome-runner__biome_lintFix':
			return { runnerKind: 'biome', operation: 'lintFix' }
		case 'mcp__biome-runner__biome_formatCheck':
			return { runnerKind: 'biome', operation: 'formatCheck' }
		case 'mcp__bun-runner__bun_runTests':
			return { runnerKind: 'bun', operation: 'runTests' }
		case 'mcp__bun-runner__bun_testFile':
			return { runnerKind: 'bun', operation: 'testFile' }
		case 'mcp__bun-runner__bun_testCoverage':
			return { runnerKind: 'bun', operation: 'testCoverage' }
		case 'mcp__tsc-runner__tsc_check':
			return { runnerKind: 'tsc', operation: 'typecheck' }
		default:
			return null
	}
}
