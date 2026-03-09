import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	readDedupState,
	resolveDedupCachePath,
	withUpdatedRecord,
	writeDedupState,
} from './dedup-store'

describe('dedup-store', () => {
	test('writes and reads records', () => {
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-'))
		const previous = process.env.TMPDIR
		process.env.TMPDIR = tmpdir
		try {
			const options = {
				projectRoot: '/tmp/project-a',
				nowMs: 10_000,
				ttlMs: 60_000,
			}
			const state = withUpdatedRecord({ entries: {} }, 'k1', {
				createdAtMs: 10_000,
				hookSeen: true,
				mcpSeen: true,
				mcpWasError: false,
			})
			writeDedupState(options, state)
			const loaded = readDedupState(options)
			expect(loaded.entries.k1?.mcpSeen).toBe(true)
		} finally {
			if (previous === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previous
			}
			rmSync(tmpdir, { recursive: true, force: true })
		}
	})

	test('fails open when cache is corrupt', () => {
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-'))
		const previous = process.env.TMPDIR
		process.env.TMPDIR = tmpdir
		try {
			const cachePath = resolveDedupCachePath('/tmp/project-b')
			writeFileSync(cachePath, '{bad json', 'utf8')
			const loaded = readDedupState({
				projectRoot: '/tmp/project-b',
				nowMs: 1_000,
				ttlMs: 60_000,
			})
			expect(loaded.entries).toEqual({})
		} finally {
			if (previous === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previous
			}
			rmSync(tmpdir, { recursive: true, force: true })
		}
	})

	test('prunes expired entries on write', () => {
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-'))
		const previous = process.env.TMPDIR
		process.env.TMPDIR = tmpdir
		try {
			writeDedupState(
				{
					projectRoot: '/tmp/project-c',
					nowMs: 100_000,
					ttlMs: 10_000,
				},
				{
					entries: {
						old: {
							createdAtMs: 1_000,
							hookSeen: true,
							mcpSeen: true,
							mcpWasError: false,
						},
						new: {
							createdAtMs: 99_000,
							hookSeen: true,
							mcpSeen: true,
							mcpWasError: false,
						},
					},
				},
			)
			const cachePath = resolveDedupCachePath('/tmp/project-c')
			const raw = readFileSync(cachePath, 'utf8')
			expect(raw.includes('"old"')).toBe(false)
			expect(raw.includes('"new"')).toBe(true)
		} finally {
			if (previous === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previous
			}
			rmSync(tmpdir, { recursive: true, force: true })
		}
	})

	test('rejects symlinked cache directory', () => {
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-'))
		const targetDir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-target-'))
		const previous = process.env.TMPDIR
		process.env.TMPDIR = tmpdir
		try {
			const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
			const cacheDirName =
				uid === undefined ? 'side-quest-hooks-cache' : `side-quest-hooks-cache-${uid}`
			symlinkSync(targetDir, path.join(tmpdir, cacheDirName))
			expect(() => resolveDedupCachePath('/tmp/project-symlink-dir')).toThrow('symlink')
		} finally {
			if (previous === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previous
			}
			rmSync(tmpdir, { recursive: true, force: true })
			rmSync(targetDir, { recursive: true, force: true })
		}
	})

	test('rejects symlinked cache file on read', () => {
		const tmpdir = mkdtempSync(path.join(os.tmpdir(), 'sq-hooks-'))
		const previous = process.env.TMPDIR
		process.env.TMPDIR = tmpdir
		try {
			const cachePath = resolveDedupCachePath('/tmp/project-symlink-file')
			const realFile = path.join(tmpdir, 'real-cache.json')
			writeFileSync(realFile, '{"version":1,"entries":{}}', 'utf8')
			rmSync(cachePath, { force: true })
			symlinkSync(realFile, cachePath)
			expect(() =>
				readDedupState({
					projectRoot: '/tmp/project-symlink-file',
					nowMs: 1_000,
					ttlMs: 60_000,
				}),
			).toThrow('symlink')
		} finally {
			if (previous === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previous
			}
			rmSync(tmpdir, { recursive: true, force: true })
		}
	})
})
