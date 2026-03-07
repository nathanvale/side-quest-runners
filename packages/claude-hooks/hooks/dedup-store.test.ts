import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
})
