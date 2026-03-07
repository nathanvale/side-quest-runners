import { z } from 'zod'
import type { HookEventName, HookOutput } from './types'

const hookEventNameSchema = z.enum([
	'PreToolUse',
	'PostToolUse',
	'PostToolUseFailure',
])

/**
 * Parsed Claude hook command input.
 */
export interface ClaudeHookInput {
	hook_event_name: HookEventName
	cwd?: string
	tool_name?: string
	tool_input?: unknown
	tool_response?: unknown
	tool_use_id?: string
	[key: string]: unknown
}

const commonInputSchema: z.ZodType<ClaudeHookInput> = z
	.object({
		hook_event_name: hookEventNameSchema,
		cwd: z.string().optional(),
		tool_name: z.string().optional(),
		tool_input: z.unknown().optional(),
		tool_response: z.unknown().optional(),
		tool_use_id: z.string().optional(),
	})
	.passthrough()

const hookSpecificOutputSchema = z
	.object({
		hookEventName: hookEventNameSchema.optional(),
		additionalContext: z.string().optional(),
		updatedMCPToolOutput: z.record(z.unknown()).optional(),
		permissionDecision: z.enum(['allow', 'deny']).optional(),
		permissionDecisionReason: z.string().optional(),
	})
	.strict()

const hookOutputSchema = z
	.object({
		continue: z.boolean().optional(),
		stopReason: z.string().optional(),
		suppressOutput: z.boolean().optional(),
		systemMessage: z.string().optional(),
		hookSpecificOutput: hookSpecificOutputSchema.optional(),
	})
	.strict()

/**
 * Parse and validate raw hook input JSON from stdin.
 */
export function parseClaudeHookInput(value: unknown): ClaudeHookInput {
	return commonInputSchema.parse(value)
}

/**
 * Validate JSON emitted to stdout for Claude hook consumption.
 */
export function validateHookOutput(output: HookOutput): HookOutput {
	return hookOutputSchema.parse(output)
}

/**
 * Build an empty but valid output envelope for a specific event.
 */
export function createEmptyHookOutput(eventName: HookEventName): HookOutput {
	return validateHookOutput({
		hookSpecificOutput: {
			hookEventName: eventName,
		},
	})
}
