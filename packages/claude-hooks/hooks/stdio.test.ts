import { describe, expect, test } from 'bun:test'
import { getStdinMaxBytes, readJsonChunksWithLimit, readStdinJsonWithLimit } from './stdio'

describe('stdio helpers', () => {
	test('getStdinMaxBytes falls back on invalid env value', () => {
		const previous = process.env.HOOK_STDIN_MAX_BYTES
		process.env.HOOK_STDIN_MAX_BYTES = 'abc'
		try {
			expect(getStdinMaxBytes()).toBe(4 * 1024 * 1024)
		} finally {
			if (previous === undefined) {
				delete process.env.HOOK_STDIN_MAX_BYTES
			} else {
				process.env.HOOK_STDIN_MAX_BYTES = previous
			}
		}
	})

	test('readJsonChunksWithLimit rejects oversized payloads', async () => {
		async function* chunks(): AsyncIterable<string> {
			yield `{"payload":"${'x'.repeat(64)}"}`
		}

		await expect(readJsonChunksWithLimit(chunks(), 32)).rejects.toThrow('exceeded limit')
	})

	test('readJsonChunksWithLimit rejects empty payloads', async () => {
		async function* chunks(): AsyncIterable<string> {
			yield '   '
		}

		await expect(readJsonChunksWithLimit(chunks(), 32)).rejects.toThrow('stdin payload is empty')
	})

	test('readStdinJsonWithLimit is exported', () => {
		expect(typeof readStdinJsonWithLimit).toBe('function')
	})
})
