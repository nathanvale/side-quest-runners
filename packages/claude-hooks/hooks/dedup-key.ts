import { createHash } from 'node:crypto'
import path from 'node:path'
import type { DedupKey, RunnerKind, RunnerOperation } from './types'

/**
 * Inputs required to create a stable dedup key.
 */
export interface DedupKeyParts {
	runnerKind: RunnerKind
	operation: RunnerOperation
	toolUseId?: string
	target: string
}

/**
 * Normalize fallback target key component from tool input payload.
 */
export function normalizeTarget(toolInput: unknown): string {
	if (typeof toolInput !== 'object' || toolInput === null) {
		return '.'
	}
	const input = toolInput as Record<string, unknown>
	const candidate =
		typeof input.path === 'string'
			? input.path
			: typeof input.file === 'string'
				? input.file
				: typeof input.pattern === 'string'
					? input.pattern
					: '.'
	const compact = candidate.trim() === '' ? '.' : candidate.trim()
	if (!/^[a-zA-Z0-9._/\-:* ]+$/.test(compact)) {
		return '.'
	}
	return path.posix.normalize(compact.replaceAll('\\', '/'))
}

/**
 * Build the canonical dedup key string with branded type safety.
 */
export function buildDedupKey(parts: DedupKeyParts): DedupKey {
	const key = parts.toolUseId
		? `${parts.runnerKind}|${parts.operation}|${parts.toolUseId}`
		: `${parts.runnerKind}|${parts.operation}|${parts.target}`
	return key as DedupKey
}

/**
 * Convert a dedup key into a stable filename-safe SHA-256 id.
 */
export function hashDedupKey(key: DedupKey): string {
	return createHash('sha256').update(key).digest('hex')
}
