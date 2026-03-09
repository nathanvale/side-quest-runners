import { createEmptyHookOutput, validateHookOutput } from './claude-schema'
import type { HookEventName, HookOutput } from './types'

/**
 * Build a standard Claude hook response envelope for additional context text.
 */
export function createContextOutput(
	eventName: HookEventName,
	additionalContext?: string,
): HookOutput {
	if (!additionalContext) {
		return createEmptyHookOutput(eventName)
	}
	return validateHookOutput({
		hookSpecificOutput: {
			hookEventName: eventName,
			additionalContext,
		},
	})
}
