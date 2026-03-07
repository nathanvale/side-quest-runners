import { describe, expect, test } from 'bun:test'
import { createHookHandler } from './index'

describe('createHookHandler', () => {
	test('writes minimal envelope when dedup feature is disabled', async () => {
		const previous = process.env.SQ_HOOK_DEDUP_ENABLED
		process.env.SQ_HOOK_DEDUP_ENABLED = '0'
		const outputs: Array<Record<string, unknown>> = []
		try {
			const handler = createHookHandler({
				readInput: async () => ({
					hook_event_name: 'PostToolUse',
					tool_name: 'mcp__bun-runner__bun_runTests',
				}),
				writeOutput: (output) => {
					outputs.push(output as Record<string, unknown>)
				},
				nowMs: () => 10_000,
			})
			await handler('posttool')
			expect(outputs).toHaveLength(1)
			expect(outputs[0]?.hookSpecificOutput).toEqual({
				hookEventName: 'PostToolUse',
			})
		} finally {
			if (previous === undefined) {
				delete process.env.SQ_HOOK_DEDUP_ENABLED
			} else {
				process.env.SQ_HOOK_DEDUP_ENABLED = previous
			}
		}
	})

	test('returns pointer on first PostToolUse when tool_response exists', async () => {
		const previous = process.env.SQ_HOOK_DEDUP_ENABLED
		process.env.SQ_HOOK_DEDUP_ENABLED = '1'
		const outputs: Array<Record<string, unknown>> = []
		try {
			const handler = createHookHandler({
				readInput: async () => ({
					hook_event_name: 'PostToolUse',
					tool_name: 'mcp__tsc-runner__tsc_check',
					cwd: process.cwd(),
					tool_input: { path: '.' },
					tool_response: { errorCount: 2, diagnostics: [{}, {}] },
				}),
				writeOutput: (output) => {
					outputs.push(output as Record<string, unknown>)
				},
				nowMs: () => Date.now(),
			})
			await handler('posttool')
			expect(outputs).toHaveLength(1)
			const hookSpecific = outputs[0]?.hookSpecificOutput as Record<string, unknown>
			expect(hookSpecific.hookEventName).toBe('PostToolUse')
			expect(typeof hookSpecific.additionalContext).toBe('string')
			expect(hookSpecific.additionalContext).toContain('Use MCP output above')
		} finally {
			if (previous === undefined) {
				delete process.env.SQ_HOOK_DEDUP_ENABLED
			} else {
				process.env.SQ_HOOK_DEDUP_ENABLED = previous
			}
		}
	})

	test('returns fallback summary when tool_response is missing', async () => {
		const previous = process.env.SQ_HOOK_DEDUP_ENABLED
		process.env.SQ_HOOK_DEDUP_ENABLED = '1'
		const outputs: Array<Record<string, unknown>> = []
		try {
			const handler = createHookHandler({
				readInput: async () => ({
					hook_event_name: 'PostToolUse',
					tool_name: 'mcp__tsc-runner__tsc_check',
					cwd: process.cwd(),
					tool_input: { path: '.' },
					// No tool_response provided
				}),
				writeOutput: (output) => {
					outputs.push(output as Record<string, unknown>)
				},
				nowMs: () => Date.now(),
			})
			await handler('posttool')
			expect(outputs).toHaveLength(1)
			const hookSpecific = outputs[0]?.hookSpecificOutput as Record<string, unknown>
			expect(hookSpecific.hookEventName).toBe('PostToolUse')
			expect(typeof hookSpecific.additionalContext).toBe('string')
			expect(hookSpecific.additionalContext).toContain('Hook summary:')
			expect(hookSpecific.additionalContext).not.toContain('Use MCP output above')
		} finally {
			if (previous === undefined) {
				delete process.env.SQ_HOOK_DEDUP_ENABLED
			} else {
				process.env.SQ_HOOK_DEDUP_ENABLED = previous
			}
		}
	})
})
