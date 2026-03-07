import { createContextOutput } from './claude-response'
import type { ClaudeHookInput } from './claude-schema'
import type { HookOutput } from './types'

/**
 * Handle `PreToolUse` events.
 *
 * Why: we intentionally keep pretool behavior passive for v1 and reserve
 * permission gating for explicit future policy decisions.
 */
export function handlePreToolUse(_input: ClaudeHookInput): HookOutput {
	return createContextOutput('PreToolUse')
}
