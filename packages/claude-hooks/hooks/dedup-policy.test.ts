import { describe, expect, test } from 'bun:test'
import { decideDedupAction } from './dedup-policy'

describe('decideDedupAction', () => {
	test('returns pointer on fresh mcp-seen record', () => {
		const result = decideDedupAction({
			eventName: 'PostToolUse',
			runnerKind: 'bun',
			operation: 'runTests',
			dedupKeyId: 'abc123',
			nowMs: 2_000,
			ttlMs: 60_000,
			existingRecord: {
				createdAtMs: 1_000,
				hookSeen: true,
				mcpSeen: true,
				mcpWasError: false,
			},
			fallbackSummary: { message: 'fallback' },
		})
		expect(result.action).toBe('pointer')
	})

	test('returns fallback on failure divergence', () => {
		const result = decideDedupAction({
			eventName: 'PostToolUseFailure',
			runnerKind: 'tsc',
			operation: 'typecheck',
			dedupKeyId: 'abc123',
			nowMs: 10_000,
			ttlMs: 60_000,
			existingRecord: {
				createdAtMs: 9_000,
				hookSeen: true,
				mcpSeen: true,
				mcpWasError: false,
			},
			fallbackSummary: { message: 'failure details' },
		})
		expect(result).toEqual({
			action: 'fallback',
			summary: { message: 'failure details' },
		})
	})

	test('returns fallback when record is missing', () => {
		const result = decideDedupAction({
			eventName: 'PostToolUse',
			runnerKind: 'biome',
			operation: 'lintCheck',
			dedupKeyId: 'abc123',
			nowMs: 10_000,
			ttlMs: 60_000,
			fallbackSummary: { message: 'lint summary' },
		})
		expect(result.action).toBe('fallback')
	})
})
