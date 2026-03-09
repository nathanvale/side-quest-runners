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
	.superRefine((value, ctx) => {
		if (
			value.hookSpecificOutput &&
			value.hookSpecificOutput.hookEventName === undefined
		) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'hookSpecificOutput requires hookEventName',
				path: ['hookSpecificOutput', 'hookEventName'],
			})
		}
	})

/**
 * Parse and validate raw hook input JSON from stdin.
 */
export function parseClaudeHookInput(value: unknown): ClaudeHookInput {
	return sanitizeClaudeHookInput(commonInputSchema.parse(value))
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

function sanitizeClaudeHookInput(input: ClaudeHookInput): ClaudeHookInput {
	return {
		hook_event_name: input.hook_event_name,
		cwd: input.cwd,
		tool_name: input.tool_name,
		tool_input: input.tool_input,
		tool_response: input.tool_response,
		tool_use_id: input.tool_use_id,
	}
}
