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
					: undefined
	const compact = candidate?.trim() ?? ''
	if (compact !== '') {
		if (hasUnsafeControlCharacters(compact)) {
			return buildInputFallbackKey(compact)
		}
		return normalizePathLikeTarget(compact)
	}

	const serialized = stableSerialize(toolInput)
	return serialized === '{}' ? '.' : buildInputFallbackKey(serialized)
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

function normalizePathLikeTarget(value: string): string {
	const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
	return normalized.trim() === '' ? '.' : normalized
}

function hasUnsafeControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) {
			return true
		}
	}
	return false
}

function buildInputFallbackKey(value: string): string {
	return `input:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function stableSerialize(value: unknown): string {
	return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => sortJson(entry))
	}
	if (typeof value !== 'object' || value === null) {
		return value
	}
	const source = value as Record<string, unknown>
	return Object.fromEntries(
		Object.keys(source)
			.sort()
			.map((key) => [key, sortJson(source[key])]),
	)
}
