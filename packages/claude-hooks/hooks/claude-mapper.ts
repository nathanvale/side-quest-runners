import { realpathSync } from 'node:fs'
import type { ClaudeHookInput } from './claude-schema'
import { buildDedupKey, hashDedupKey, normalizeTarget } from './dedup-key'
import { emitMetric } from './observability'
import { inferRunnerMapping } from './runner-mapping'
import type { RunnerKind, RunnerOperation } from './types'

/**
 * Normalized event payload consumed by dedup policy and store.
 */
export interface DedupIntent {
	eventName: 'PostToolUse' | 'PostToolUseFailure'
	runnerKind: RunnerKind
	operation: RunnerOperation
	projectRoot: string
	dedupKey: string
	dedupKeyId: string
	toolResponse?: unknown
}

/**
 * Convert a Claude event payload into a dedup intent or `null` when unsupported.
 */
export function mapClaudeEventToDedupIntent(
	input: ClaudeHookInput,
): DedupIntent | null {
	if (
		input.hook_event_name !== 'PostToolUse' &&
		input.hook_event_name !== 'PostToolUseFailure'
	) {
		return null
	}
	if (!input.tool_name) {
		return null
	}
	const mapping = inferRunnerMapping(input.tool_name)
	if (!mapping) {
		emitMetric('hook.mapping.unknownToolName', {
			eventName: input.hook_event_name,
			toolName: input.tool_name,
		})
		return null
	}
	const target = normalizeTarget(input.tool_input)
	const dedupKey = buildDedupKey({
		runnerKind: mapping.runnerKind,
		operation: mapping.operation,
		toolUseId: input.tool_use_id,
		target,
	})
	const projectRoot = resolveProjectRoot(input.cwd)
	return {
		eventName: input.hook_event_name,
		runnerKind: mapping.runnerKind,
		operation: mapping.operation,
		projectRoot,
		dedupKey,
		dedupKeyId: hashDedupKey(dedupKey),
		toolResponse: input.tool_response,
	}
}

function resolveProjectRoot(cwd: string | undefined): string {
	const base = cwd && cwd.trim() !== '' ? cwd : process.cwd()
	try {
		return realpathSync(base)
	} catch {
		try {
			return realpathSync(process.cwd())
		} catch {
			return process.cwd()
		}
	}
}
