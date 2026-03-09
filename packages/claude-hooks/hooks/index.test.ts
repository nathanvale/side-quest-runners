import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mapClaudeEventToDedupIntent } from './claude-mapper'
import { readDedupState } from './dedup-store'
import { createHookHandler, runCli } from './index'

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
		const previousTmpdir = process.env.TMPDIR
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-index-'))
		process.env.SQ_HOOK_DEDUP_ENABLED = '1'
		process.env.TMPDIR = tmpdir
		const outputs: Array<Record<string, unknown>> = []
		const input = {
			hook_event_name: 'PostToolUse' as const,
			tool_name: 'mcp__tsc-runner__tsc_check',
			cwd: process.cwd(),
			tool_input: { path: '.' },
		}
		try {
			const handler = createHookHandler({
				readInput: async () => input,
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

			const intent = mapClaudeEventToDedupIntent(input)
			expect(intent).not.toBeNull()
			if (!intent) {
				throw new Error('expected dedup intent for test payload')
			}
			const state = readDedupState({
				projectRoot: intent.projectRoot,
				nowMs: Date.now(),
				ttlMs: 60_000,
			})
			expect(state.entries[intent.dedupKeyId]?.mcpSeen).toBe(false)
		} finally {
			if (previous === undefined) {
				delete process.env.SQ_HOOK_DEDUP_ENABLED
			} else {
				process.env.SQ_HOOK_DEDUP_ENABLED = previous
			}
			if (previousTmpdir === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previousTmpdir
			}
			rmSync(tmpdir, { recursive: true, force: true })
		}
	})

	test('runCli writes failsafe JSON for invalid subcommands', async () => {
		const stdoutChunks: string[] = []
		const stderrChunks: string[] = []
		const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
			(chunk: string | Uint8Array) => {
				stdoutChunks.push(String(chunk))
				return true
			},
		)
		const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
			(chunk: string | Uint8Array) => {
				stderrChunks.push(String(chunk))
				return true
			},
		)
		try {
			await runCli(['bun', 'sq-claude-hook', 'bad-subcommand'])
			const payload = JSON.parse(stdoutChunks.join(''))
			expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse')
			expect(stderrChunks.join('')).toContain('unknown subcommand')
		} finally {
			stdoutSpy.mockRestore()
			stderrSpy.mockRestore()
		}
	})

	test('runCli writes failsafe JSON when hook input parsing fails', async () => {
		const stdoutChunks: string[] = []
		const stderrChunks: string[] = []
		const stdoutSpy = spyOn(process.stdout, 'write').mockImplementation(
			(chunk: string | Uint8Array) => {
				stdoutChunks.push(String(chunk))
				return true
			},
		)
		const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(
			(chunk: string | Uint8Array) => {
				stderrChunks.push(String(chunk))
				return true
			},
		)
		try {
			await runCli(['bun', 'sq-claude-hook', 'posttool'], {
				readInput: async () => {
					throw new Error('stdin payload exceeded limit (32 bytes)')
				},
			})
			const payload = JSON.parse(stdoutChunks.join(''))
			expect(payload.hookSpecificOutput.hookEventName).toBe('PostToolUse')
			expect(stderrChunks.join('')).toContain('stdin payload exceeded limit')
		} finally {
			stdoutSpy.mockRestore()
			stderrSpy.mockRestore()
		}
	})
})
