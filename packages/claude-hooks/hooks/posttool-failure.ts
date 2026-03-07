import { mapClaudeEventToDedupIntent } from './claude-mapper'
import { createContextOutput } from './claude-response'
import type { ClaudeHookInput } from './claude-schema'
import { decideDedupAction } from './dedup-policy'
import {
	readDedupState,
	withUpdatedRecord,
	writeDedupState,
} from './dedup-store'
import type { HookOutput } from './types'

/**
 * Handle `PostToolUseFailure` with explicit protection against success-path suppression.
 */
export function handlePostToolUseFailure(
	input: ClaudeHookInput,
	nowMs: number,
	ttlMs: number,
): HookOutput {
	const intent = mapClaudeEventToDedupIntent(input)
	if (!intent) {
		return createContextOutput('PostToolUseFailure')
	}
	const state = readDedupState({
		projectRoot: intent.projectRoot,
		nowMs,
		ttlMs,
	})
	const existing = state.entries[intent.dedupKeyId]
	const decision = decideDedupAction({
		eventName: 'PostToolUseFailure',
		runnerKind: intent.runnerKind,
		operation: intent.operation,
		dedupKeyId: intent.dedupKeyId,
		nowMs,
		ttlMs,
		existingRecord: existing,
		fallbackSummary: {
			message: `Hook failure: ${intent.runnerKind}/${intent.operation} emitted a failure event.`,
		},
	})

	const nextState = withUpdatedRecord(state, intent.dedupKeyId, {
		createdAtMs: nowMs,
		hookSeen: true,
		mcpSeen: existing?.mcpSeen ?? false,
		mcpWasError: existing?.mcpWasError ?? false,
	})
	writeDedupState(
		{
			projectRoot: intent.projectRoot,
			nowMs,
			ttlMs,
		},
		nextState,
	)

	if (decision.action === 'pointer') {
		return createContextOutput('PostToolUseFailure', decision.message)
	}
	return createContextOutput('PostToolUseFailure', decision.summary.message)
}
