import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { handlePostToolUse } from './posttool'
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

	test('does not suppress failure after success-path PostToolUse', () => {
		const previousTmpdir = process.env.TMPDIR
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-failure-'))
		process.env.TMPDIR = tmpdir
		try {
			const nowMs = Date.now()
			const successInput = {
				hook_event_name: 'PostToolUse' as const,
				tool_name: 'mcp__tsc-runner__tsc_check',
				tool_use_id: 'toolu_divergence',
				cwd: process.cwd(),
				tool_input: { path: '.' },
				tool_response: { isError: false, errorCount: 0, errors: [] },
			}
			handlePostToolUse(successInput, nowMs, 60_000)

			const failureOutput = handlePostToolUseFailure(
				{
					hook_event_name: 'PostToolUseFailure',
					tool_name: 'mcp__tsc-runner__tsc_check',
					tool_use_id: 'toolu_divergence',
					cwd: process.cwd(),
					tool_input: { path: '.' },
				},
				nowMs + 1_000,
				60_000,
			)

			expect(failureOutput.hookSpecificOutput?.hookEventName).toBe('PostToolUseFailure')
			expect(failureOutput.hookSpecificOutput?.additionalContext).toContain('failure event')
			expect(failureOutput.hookSpecificOutput?.additionalContext).not.toContain('Dedup hit:')
		} finally {
			if (previousTmpdir === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previousTmpdir
			}
			rmSync(tmpdir, { recursive: true, force: true })
		}
	})
})
