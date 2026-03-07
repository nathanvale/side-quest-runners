import { mapClaudeEventToDedupIntent } from './claude-mapper'
import { createContextOutput } from './claude-response'
import type { ClaudeHookInput } from './claude-schema'
import { decideDedupAction } from './dedup-policy'
import {
	readDedupState,
	withUpdatedRecord,
	writeDedupState,
} from './dedup-store'
import { emitMetric } from './observability'
import type { HookOutput } from './types'

/**
 * Handle `PostToolUse` dedup behavior for supported runner tools.
 */
export function handlePostToolUse(
	input: ClaudeHookInput,
	nowMs: number,
	ttlMs: number,
): HookOutput {
	const intent = mapClaudeEventToDedupIntent(input)
	if (!intent) {
		return createContextOutput('PostToolUse')
	}

	const fallbackSummary = {
		message: buildFallbackSummary(
			intent.runnerKind,
			intent.operation,
			intent.toolResponse,
		),
	}
	try {
		const state = readDedupState({
			projectRoot: intent.projectRoot,
			nowMs,
			ttlMs,
		})
		const existing = state.entries[intent.dedupKeyId]
		const decision = decideDedupAction({
			eventName: 'PostToolUse',
			runnerKind: intent.runnerKind,
			operation: intent.operation,
			dedupKeyId: intent.dedupKeyId,
			nowMs,
			ttlMs,
			existingRecord: existing,
			fallbackSummary,
		})

		const nextRecord = {
			createdAtMs: nowMs,
			hookSeen: true,
			mcpSeen: true,
			mcpWasError: readMcpErrorFlag(intent.toolResponse),
		}
		const nextState = withUpdatedRecord(state, intent.dedupKeyId, nextRecord)
		writeDedupState(
			{
				projectRoot: intent.projectRoot,
				nowMs,
				ttlMs,
			},
			nextState,
		)

		if (decision.action === 'pointer') {
			return createContextOutput('PostToolUse', decision.message)
		}
		return createContextOutput('PostToolUse', decision.summary.message)
	} catch (error) {
		emitMetric('hook.cache.writeError', {
			event: 'PostToolUse',
			error: error instanceof Error ? error.message : String(error),
		})
		return createContextOutput('PostToolUse', fallbackSummary.message)
	}
}

function buildFallbackSummary(
	runnerKind: string,
	operation: string,
	toolResponse: unknown,
): string {
	const response = (toolResponse ?? {}) as Record<string, unknown>
	const maybeErrorCount =
		typeof response.errorCount === 'number' ? response.errorCount : undefined
	const maybeWarningCount =
		typeof response.warningCount === 'number'
			? response.warningCount
			: undefined
	const maybeFailed =
		typeof response.failed === 'number' ? response.failed : undefined
	const maybeTotal =
		typeof response.total === 'number' ? response.total : undefined
	const maybeDiagnostics = Array.isArray(response.diagnostics)
		? response.diagnostics.length
		: undefined

	const parts = [
		`Hook summary: ${runnerKind}/${operation}`,
		maybeErrorCount === undefined ? undefined : `errors=${maybeErrorCount}`,
		maybeWarningCount === undefined
			? undefined
			: `warnings=${maybeWarningCount}`,
		maybeFailed === undefined ? undefined : `failed=${maybeFailed}`,
		maybeTotal === undefined ? undefined : `total=${maybeTotal}`,
		maybeDiagnostics === undefined
			? undefined
			: `diagnostics=${maybeDiagnostics}`,
	].filter((entry): entry is string => Boolean(entry))

	return parts.join(' ')
}

function readMcpErrorFlag(toolResponse: unknown): boolean {
	if (typeof toolResponse !== 'object' || toolResponse === null) {
		return false
	}
	const response = toolResponse as Record<string, unknown>
	return response.isError === true
}
