import type {
	DedupDecision,
	DedupRecord,
	FallbackSummary,
	RunnerKind,
	RunnerOperation,
} from './types'

/**
 * Inputs needed to decide pointer vs fallback output.
 */
export interface DedupPolicyInput {
	eventName: 'PostToolUse' | 'PostToolUseFailure'
	runnerKind: RunnerKind
	operation: RunnerOperation
	dedupKeyId: string
	nowMs: number
	ttlMs: number
	existingRecord?: DedupRecord
	fallbackSummary: FallbackSummary
}

/**
 * Decide whether hook output should be dedup pointer or fallback summary.
 */
export function decideDedupAction(input: DedupPolicyInput): DedupDecision {
	const existing = input.existingRecord
	if (
		input.eventName === 'PostToolUseFailure' &&
		existing?.mcpSeen === true &&
		existing.mcpWasError === false
	) {
		return { action: 'fallback', summary: input.fallbackSummary }
	}

	if (
		existing?.mcpSeen === true &&
		input.nowMs - existing.createdAtMs <= input.ttlMs
	) {
		return {
			action: 'pointer',
			dedupKey: input.dedupKeyId,
			mcpSeenAtMs: existing.createdAtMs,
			message: `Dedup hit: ${input.runnerKind}/${input.operation} key=${input.dedupKeyId.slice(0, 12)}. Use MCP output above.`,
		}
	}

	return { action: 'fallback', summary: input.fallbackSummary }
}
