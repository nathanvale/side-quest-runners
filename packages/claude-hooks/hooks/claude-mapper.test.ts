import { describe, expect, test } from 'bun:test'
import { mapClaudeEventToDedupIntent } from './claude-mapper'

describe('mapClaudeEventToDedupIntent', () => {
	test('falls back safely when cwd cannot be resolved', () => {
		const intent = mapClaudeEventToDedupIntent({
			hook_event_name: 'PostToolUse',
			cwd: '/definitely/missing/path',
			tool_name: 'mcp__tsc-runner__tsc_check',
			tool_input: { path: '.' },
			tool_use_id: 'toolu_mapper_123',
		})

		expect(intent).not.toBeNull()
		expect(intent?.projectRoot.length).toBeGreaterThan(0)
	})
})
