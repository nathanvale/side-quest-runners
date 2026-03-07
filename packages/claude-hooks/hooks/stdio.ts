import type { ClaudeHookInput } from './claude-schema'
import { createEmptyHookOutput, parseClaudeHookInput } from './claude-schema'
import type { HookEventName, HookOutput } from './types'

const DEFAULT_STDIN_MAX_BYTES = 4 * 1024 * 1024

/**
 * Parse `HOOK_STDIN_MAX_BYTES` with a safe fallback.
 */
export function getStdinMaxBytes(): number {
	const raw = process.env.HOOK_STDIN_MAX_BYTES
	if (!raw) {
		return DEFAULT_STDIN_MAX_BYTES
	}
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_STDIN_MAX_BYTES
	}
	return Math.floor(parsed)
}

/**
 * Read stdin with a hard byte cap to avoid unbounded memory growth.
 */
export async function readStdinJsonWithLimit(
	maxBytes: number,
): Promise<unknown> {
	let total = 0
	let content = ''
	for await (const chunk of process.stdin) {
		const text =
			typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
		total += Buffer.byteLength(text)
		if (total > maxBytes) {
			throw new Error(`stdin payload exceeded limit (${maxBytes} bytes)`)
		}
		content += text
	}
	if (content.trim() === '') {
		throw new Error('stdin payload is empty')
	}
	return JSON.parse(content)
}

/**
 * Read, parse, and validate Claude hook input from stdin.
 */
export async function readClaudeHookInput(): Promise<ClaudeHookInput> {
	const raw = await readStdinJsonWithLimit(getStdinMaxBytes())
	return parseClaudeHookInput(raw)
}

/**
 * Write one JSON object to stdout; no additional text is allowed.
 */
export function writeHookOutput(output: HookOutput): void {
	process.stdout.write(`${JSON.stringify(output)}\n`)
}

/**
 * Emit a guaranteed-valid minimal JSON envelope after internal failures.
 */
export function writeFailsafeJson(
	eventName: HookEventName = 'PostToolUse',
): void {
	writeHookOutput(createEmptyHookOutput(eventName))
}
