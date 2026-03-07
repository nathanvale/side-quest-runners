/**
 * Claude hook command subcommands exposed by the CLI binary.
 */
export type HookCommand = 'pretool' | 'posttool' | 'posttool-failure'

/**
 * Claude hook event names we currently support.
 */
export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'

/**
 * Runner families that participate in dedup behavior.
 */
export type RunnerKind = 'biome' | 'bun' | 'tsc'

/**
 * Normalized runner operations used for dedup key generation.
 */
export type RunnerOperation =
	| 'lintCheck'
	| 'lintFix'
	| 'formatCheck'
	| 'runTests'
	| 'testFile'
	| 'testCoverage'
	| 'typecheck'

/**
 * Branded dedup key to avoid accidental raw string usage in APIs.
 */
export type DedupKey = string & { readonly __brand: unique symbol }

/**
 * Dedup cache record persisted in TMPDIR-backed JSON store.
 */
export interface DedupRecord {
	createdAtMs: number
	hookSeen: boolean
	mcpSeen: boolean
	mcpWasError: boolean
}

/**
 * Minimal summary text used when no dedup hit is available.
 */
export interface FallbackSummary {
	message: string
}

/**
 * Dedup policy result for a hook invocation.
 */
export type DedupDecision =
	| {
			action: 'pointer'
			message: string
			dedupKey: string
			mcpSeenAtMs: number
	  }
	| { action: 'fallback'; summary: FallbackSummary }

/**
 * Hook output shape used by Claude command hooks.
 */
export interface HookOutput {
	continue?: boolean
	stopReason?: string
	suppressOutput?: boolean
	systemMessage?: string
	hookSpecificOutput?: {
		hookEventName?: HookEventName
		additionalContext?: string
		updatedMCPToolOutput?: Record<string, unknown>
		permissionDecision?: 'allow' | 'deny'
		permissionDecisionReason?: string
	}
}
