import { describe, expect, test } from 'bun:test'
import { handlePostToolUseFailure } from './posttool-failure'

describe('handlePostToolUseFailure', () => {
	test('returns a valid fallback response for supported tools', () => {
		const output = handlePostToolUseFailure(
			{
				hook_event_name: 'PostToolUseFailure',
				tool_name: 'mcp__tsc-runner__tsc_check',
				tool_use_id: 'toolu_123',
				tool_input: { path: '.' },
			},
			Date.now(),
			60_000,
		)

		expect(output.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure')
		expect(typeof output.hookSpecificOutput?.additionalContext).toBe('string')
	})
})
