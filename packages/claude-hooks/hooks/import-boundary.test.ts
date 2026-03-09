import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('core import boundaries', () => {
	test('dedup core modules do not import claude-* modules', () => {
		const coreFiles = ['dedup-key.ts', 'dedup-policy.ts', 'dedup-store.ts', 'types.ts']

		for (const file of coreFiles) {
			const absolutePath = path.join(import.meta.dir, file)
			const source = readFileSync(absolutePath, 'utf8')
			expect(source).not.toMatch(/from ['"]\.\/claude-/)
		}
	})
})
