import { createHash, randomBytes } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { emitMetric } from './observability'
import type { DedupRecord } from './types'

const DEFAULT_MAX_ENTRIES = 2_000

const dedupRecordSchema = z.object({
	createdAtMs: z.number(),
	hookSeen: z.boolean(),
	mcpSeen: z.boolean(),
	mcpWasError: z.boolean(),
})

const dedupFileSchema = z.object({
	version: z.literal(1),
	entries: z.record(dedupRecordSchema),
})

/**
 * In-memory representation of dedup cache file content.
 */
export interface DedupState {
	entries: Record<string, DedupRecord>
}

/**
 * Read/write options controlling dedup cache lifecycle.
 */
export interface DedupStoreOptions {
	projectRoot: string
	ttlMs: number
	nowMs: number
	maxEntries?: number
}

class DedupStoreSecurityError extends Error {}

/**
 * Resolve cache file path for the current project root.
 */
export function resolveDedupCachePath(projectRoot: string): string {
	const tmpBase = process.env.TMPDIR ?? os.tmpdir()
	const uid =
		typeof process.getuid === 'function' ? process.getuid() : undefined
	const cacheDirName =
		uid === undefined
			? 'side-quest-hooks-cache'
			: `side-quest-hooks-cache-${uid}`
	const cacheDir = path.join(tmpBase, cacheDirName)
	ensureSecureDirectory(cacheDir, uid)
	const fileId = createHash('sha256').update(projectRoot).digest('hex')
	return path.join(cacheDir, `${fileId}.json`)
}

/**
 * Read dedup state from disk and fail open to an empty state on corruption.
 */
export function readDedupState(options: DedupStoreOptions): DedupState {
	const cachePath = resolveDedupCachePath(options.projectRoot)
	if (!existsSync(cachePath)) {
		return { entries: {} }
	}
	assertNotSymlink(cachePath)
	try {
		const raw = readFileSync(cachePath, 'utf8')
		const parsed = JSON.parse(raw)
		const validated = dedupFileSchema.parse(parsed)
		return {
			entries: pruneEntries(
				validated.entries,
				options.nowMs,
				options.ttlMs,
				options.maxEntries,
			),
		}
	} catch (error) {
		if (error instanceof DedupStoreSecurityError) {
			emitMetric('hook.cache.securityError', {
				phase: 'read',
				error: error.message,
			})
			throw error
		}
		emitMetric('hook.cache.readCorrupt', {
			error: error instanceof Error ? error.message : String(error),
		})
		return { entries: {} }
	}
}

/**
 * Persist dedup state to disk via atomic rename in the same directory.
 */
export function writeDedupState(
	options: DedupStoreOptions,
	state: DedupState,
): void {
	const cachePath = resolveDedupCachePath(options.projectRoot)
	const directory = path.dirname(cachePath)
	const entries = pruneEntries(
		state.entries,
		options.nowMs,
		options.ttlMs,
		options.maxEntries,
	)
	const payload = JSON.stringify({ version: 1 as const, entries })
	const tempPath = `${cachePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
	try {
		writeFileSync(tempPath, payload, { encoding: 'utf8', mode: 0o600 })
		renameSync(tempPath, cachePath)
		chmodSync(cachePath, 0o600)
	} catch (error) {
		try {
			unlinkSync(tempPath)
		} catch {
			// Ignore cleanup failures on error path.
		}
		throw error
	}
	// Ensure parent remains owner-only even when pre-created.
	chmodSync(directory, 0o700)
}

/**
 * Upsert one dedup record and return the updated state object.
 */
export function withUpdatedRecord(
	state: DedupState,
	key: string,
	record: DedupRecord,
): DedupState {
	return {
		entries: {
			...state.entries,
			[key]: record,
		},
	}
}

function ensureSecureDirectory(directory: string, expectedUid?: number): void {
	if (!existsSync(directory)) {
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		chmodSync(directory, 0o700)
		return
	}
	const stats = lstatSync(directory)
	if (stats.isSymbolicLink()) {
		throw new DedupStoreSecurityError(
			`dedup cache directory cannot be a symlink: ${directory}`,
		)
	}
	if (!stats.isDirectory()) {
		throw new DedupStoreSecurityError(
			`dedup cache path is not a directory: ${directory}`,
		)
	}
	if (expectedUid !== undefined && stats.uid !== expectedUid) {
		throw new DedupStoreSecurityError(
			`dedup cache directory uid mismatch: ${directory}`,
		)
	}
	chmodSync(directory, 0o700)
}

function assertNotSymlink(filePath: string): void {
	const stats = lstatSync(filePath)
	if (stats.isSymbolicLink()) {
		throw new DedupStoreSecurityError(
			`dedup cache file cannot be a symlink: ${filePath}`,
		)
	}
}

function pruneEntries(
	entries: Record<string, DedupRecord>,
	nowMs: number,
	ttlMs: number,
	maxEntries = DEFAULT_MAX_ENTRIES,
): Record<string, DedupRecord> {
	const valid = Object.entries(entries).filter(
		([, record]) => nowMs - record.createdAtMs <= ttlMs,
	)
	if (valid.length <= maxEntries) {
		return Object.fromEntries(valid)
	}
	valid.sort((a, b) => a[1].createdAtMs - b[1].createdAtMs)
	const trimmed = valid.slice(valid.length - maxEntries)
	return Object.fromEntries(trimmed)
}
