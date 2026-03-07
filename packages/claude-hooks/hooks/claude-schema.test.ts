import { describe, expect, test } from 'bun:test'
import { parseClaudeHookInput, validateHookOutput } from './claude-schema'

describe('parseClaudeHookInput', () => {
	test('accepts known posttool event shape', () => {
		const parsed = parseClaudeHookInput({
			hook_event_name: 'PostToolUse',
			tool_name: 'mcp__bun-runner__bun_runTests',
			tool_use_id: 'toolu_123',
			tool_input: { pattern: 'auth' },
		})
		expect(parsed.tool_name).toBe('mcp__bun-runner__bun_runTests')
	})
})

describe('validateHookOutput', () => {
	test('accepts hookSpecificOutput envelopes', () => {
		const output = validateHookOutput({
			hookSpecificOutput: {
				hookEventName: 'PostToolUse',
				additionalContext: 'Dedup hit',
			},
		})
		expect(output.hookSpecificOutput?.hookEventName).toBe('PostToolUse')
	})

	test('rejects deprecated top-level decision field', () => {
		expect(() =>
			validateHookOutput({
				decision: 'allow',
			} as unknown as Parameters<typeof validateHookOutput>[0]),
		).toThrow()
	})
})
