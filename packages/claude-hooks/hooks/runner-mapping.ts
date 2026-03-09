import type { RunnerKind, RunnerOperation } from './types'

export interface RunnerMapping {
	runnerKind: RunnerKind
	operation: RunnerOperation
}

const BIOME_TOOL_MAPPINGS: Record<string, RunnerOperation> = {
	biome_lintCheck: 'lintCheck',
	biome_lintFix: 'lintFix',
	biome_formatCheck: 'formatCheck',
}

const BUN_TOOL_MAPPINGS: Record<string, RunnerOperation> = {
	bun_runTests: 'runTests',
	bun_testFile: 'testFile',
	bun_testCoverage: 'testCoverage',
}

const TSC_TOOL_MAPPINGS: Record<string, RunnerOperation> = {
	tsc_check: 'typecheck',
}

/**
 * Infer runner family + operation from Claude MCP tool naming convention.
 */
export function inferRunnerMapping(toolName: string): RunnerMapping | null {
	const parts = toolName.split('__')
	if (parts.length !== 3 || parts[0] !== 'mcp') {
		return null
	}

	const serverName = parts[1]
	const operationName = parts[2]
	if (!serverName || !operationName) {
		return null
	}

	if (serverName.endsWith('biome-runner')) {
		const operation = BIOME_TOOL_MAPPINGS[operationName]
		return operation ? { runnerKind: 'biome', operation } : null
	}

	if (serverName.endsWith('bun-runner')) {
		const operation = BUN_TOOL_MAPPINGS[operationName]
		return operation ? { runnerKind: 'bun', operation } : null
	}

	if (serverName.endsWith('tsc-runner')) {
		const operation = TSC_TOOL_MAPPINGS[operationName]
		return operation ? { runnerKind: 'tsc', operation } : null
	}

	return null
}
