#!/usr/bin/env bun

import { createEmptyHookOutput } from './claude-schema'
import { emitMetric, setupObservability } from './observability'
import { handlePostToolUse } from './posttool'
import { handlePostToolUseFailure } from './posttool-failure'
import { handlePreToolUse } from './pretool'
import {
	readClaudeHookInput,
	writeFailsafeJson,
	writeHookOutput,
} from './stdio'
import type { HookCommand, HookOutput } from './types'

/**
 * Dependencies injected for handler testability.
 */
export interface HookHandlerDependencies {
	readInput: typeof readClaudeHookInput
	writeOutput: typeof writeHookOutput
	nowMs: () => number
}

/**
 * Create a command handler with injectable IO for integration testing.
 */
export function createHookHandler(deps?: Partial<HookHandlerDependencies>) {
	const runtime: HookHandlerDependencies = {
		readInput: deps?.readInput ?? readClaudeHookInput,
		writeOutput: deps?.writeOutput ?? writeHookOutput,
		nowMs: deps?.nowMs ?? (() => Date.now()),
	}

	return async (command: HookCommand): Promise<HookOutput> => {
		const input = await runtime.readInput()
		const dedupEnabled = isDedupEnabled()
		const eventName = input.hook_event_name
		if (!dedupEnabled) {
			const output = createEmptyHookOutput(eventName)
			runtime.writeOutput(output)
			return output
		}

		const ttlMs = getEventTtlMs()
		const output = routeHookCommand(command, input, runtime.nowMs(), ttlMs)
		runtime.writeOutput(output)
		return output
	}
}

/**
 * Execute CLI command with stdout-safety fallback on all unexpected errors.
 */
export async function runCli(argv: string[]): Promise<void> {
	const startedAtMs = Date.now()
	const command = parseCommand(argv)
	const handler = createHookHandler()
	try {
		await setupObservability()
		emitMetric('hook.events.total', { command })
		const output = await handler(command)
		recordOutputMetrics(command, output)
	} catch (error) {
		process.stderr.write(`sq-claude-hook error: ${String(error)}\n`)
		writeFailsafeJson(commandToEventName(command))
	} finally {
		emitMetric('hook.latency.totalMs', {
			command,
			totalMs: Date.now() - startedAtMs,
		})
	}
}

function parseCommand(argv: string[]): HookCommand {
	const candidate = argv[2]
	if (
		candidate === 'pretool' ||
		candidate === 'posttool' ||
		candidate === 'posttool-failure'
	) {
		return candidate
	}
	throw new Error(`unknown subcommand: ${candidate ?? '<missing>'}`)
}

function routeHookCommand(
	command: HookCommand,
	input: Awaited<ReturnType<typeof readClaudeHookInput>>,
	nowMs: number,
	ttlMs: number,
): HookOutput {
	switch (command) {
		case 'pretool':
			return handlePreToolUse(input)
		case 'posttool':
			return handlePostToolUse(input, nowMs, ttlMs)
		case 'posttool-failure':
			return handlePostToolUseFailure(input, nowMs, ttlMs)
	}
}

function getEventTtlMs(): number {
	const raw = process.env.SQ_HOOK_EVENT_TTL_MS
	if (!raw) {
		return process.env.TF_BUILD === 'true' ? 90_000 : 60_000
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return 60_000
	}
	return Math.floor(parsed)
}

function isDedupEnabled(): boolean {
	return process.env.SQ_HOOK_DEDUP_ENABLED === '1'
}

function commandToEventName(
	command: HookCommand,
): 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' {
	switch (command) {
		case 'pretool':
			return 'PreToolUse'
		case 'posttool':
			return 'PostToolUse'
		case 'posttool-failure':
			return 'PostToolUseFailure'
	}
}

if (import.meta.main) {
	await runCli(process.argv)
}

function recordOutputMetrics(command: HookCommand, output: HookOutput): void {
	const additionalContext = output.hookSpecificOutput?.additionalContext
	if (
		typeof additionalContext !== 'string' ||
		additionalContext.trim() === ''
	) {
		return
	}

	if (additionalContext.startsWith('Dedup hit:')) {
		emitMetric('hook.dedup.hit', { command })
		emitMetric('hook.output.pointer', { command })
		return
	}

	emitMetric('hook.dedup.miss', { command })
	emitMetric('hook.output.fallback', { command })
	if (command === 'posttool-failure') {
		emitMetric('hook.dedup.failureNotSuppressed', { command })
	}
}
