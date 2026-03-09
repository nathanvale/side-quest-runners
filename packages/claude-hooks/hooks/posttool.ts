import { mapClaudeEventToDedupIntent } from './claude-mapper'
import { createContextOutput } from './claude-response'
import type { ClaudeHookInput } from './claude-schema'
import {
	readDedupState,
	withUpdatedRecord,
	writeDedupState,
} from './dedup-store'
import { emitMetric } from './observability'
import type { HookOutput } from './types'

/**
 * Handle `PostToolUse` dedup behavior for supported runner tools.
 *
 * PostToolUse always runs AFTER the MCP tool has returned its result,
 * so the MCP output is already present in Claude's context. For mapped
 * (recognized) tools with a `tool_response`, we always emit a pointer
 * saying "see the MCP output above" rather than repeating a summary.
 *
 * The dedup record is still written so that future `PostToolUseFailure`
 * events can detect divergence (MCP succeeded but Claude marked failure).
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

	const hasToolResponse = intent.toolResponse !== undefined

	try {
		// Always write the dedup record for future PostToolUseFailure lookups
		const state = readDedupState({
			projectRoot: intent.projectRoot,
			nowMs,
			ttlMs,
		})
		const nextRecord = {
			createdAtMs: nowMs,
			hookSeen: true,
			mcpSeen: hasToolResponse,
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

		// Mapped tool with response: always pointer (MCP output is above)
		if (hasToolResponse) {
			const pointerMessage = `Dedup hit: ${intent.runnerKind}/${intent.operation} key=${intent.dedupKeyId.slice(0, 12)}. Use MCP output above.`
			return createContextOutput('PostToolUse', pointerMessage)
		}

		// Mapped tool without response: fallback summary
		const fallbackMessage = buildFallbackSummary(
			intent.runnerKind,
			intent.operation,
			intent.toolResponse,
		)
		return createContextOutput('PostToolUse', fallbackMessage)
	} catch (error) {
		emitMetric('hook.cache.writeError', {
			event: 'PostToolUse',
			error: error instanceof Error ? error.message : String(error),
		})
		const fallbackMessage = buildFallbackSummary(
			intent.runnerKind,
			intent.operation,
			intent.toolResponse,
		)
		return createContextOutput('PostToolUse', fallbackMessage)
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
	if (response.isError === true) {
		return true
	}
	if (typeof response.error === 'string') {
		return true
	}
	if (typeof response.error === 'object' && response.error !== null) {
		return true
	}

	const structuredContent = response.structuredContent
	if (
		typeof structuredContent === 'object' &&
		structuredContent !== null &&
		typeof (structuredContent as Record<string, unknown>).code === 'string' &&
		typeof (structuredContent as Record<string, unknown>).message === 'string'
	) {
		return true
	}

	return (
		typeof response.code === 'string' && typeof response.message === 'string'
	)
}
