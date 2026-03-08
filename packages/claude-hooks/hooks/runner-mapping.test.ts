import { describe, expect, test } from 'bun:test'
import { inferRunnerMapping } from './runner-mapping'

describe('inferRunnerMapping', () => {
	test('matches canonical runner tool names', () => {
		expect(inferRunnerMapping('mcp__biome-runner__biome_lintCheck')).toEqual({
			runnerKind: 'biome',
			operation: 'lintCheck',
		})
		expect(inferRunnerMapping('mcp__bun-runner__bun_runTests')).toEqual({
			runnerKind: 'bun',
			operation: 'runTests',
		})
		expect(inferRunnerMapping('mcp__tsc-runner__tsc_check')).toEqual({
			runnerKind: 'tsc',
			operation: 'typecheck',
		})
	})

	test('accepts server name variants that preserve runner suffixes', () => {
		expect(inferRunnerMapping('mcp__side-quest-biome-runner__biome_lintFix')).toEqual({
			runnerKind: 'biome',
			operation: 'lintFix',
		})
		expect(inferRunnerMapping('mcp__acme-bun-runner__bun_testCoverage')).toEqual({
			runnerKind: 'bun',
			operation: 'testCoverage',
		})
	})

	test('returns null for unsupported tool names', () => {
		expect(inferRunnerMapping('mcp__random-server__unknown_tool')).toBeNull()
		expect(inferRunnerMapping('not-even-close')).toBeNull()
	})
})
