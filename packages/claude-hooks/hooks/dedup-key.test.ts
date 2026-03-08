import { describe, expect, test } from 'bun:test'
import { buildDedupKey, hashDedupKey, normalizeTarget } from './dedup-key'

describe('normalizeTarget', () => {
	test('uses known path-like fields', () => {
		expect(normalizeTarget({ path: 'src/index.ts' })).toBe('src/index.ts')
		expect(normalizeTarget({ file: 'tests/unit.test.ts' })).toBe('tests/unit.test.ts')
		expect(normalizeTarget({ pattern: 'auth' })).toBe('auth')
	})

	test('falls back to dot on unsafe or missing values', () => {
		expect(normalizeTarget({})).toBe('.')
		expect(normalizeTarget({ path: '../\u0000bad' })).toMatch(/^input:/)
	})

	test('preserves unicode path-like values', () => {
		expect(normalizeTarget({ path: 'src/naive-cafe/こんにちは.ts' })).toBe(
			'src/naive-cafe/こんにちは.ts',
		)
	})

	test('uses stable hashed fallback for non-path-like objects', () => {
		expect(normalizeTarget({ response_format: 'json', limit: 5 })).toBe(
			normalizeTarget({ limit: 5, response_format: 'json' }),
		)
		expect(normalizeTarget({ response_format: 'json', limit: 5 })).toMatch(/^input:/)
	})
})

describe('dedup keys', () => {
	test('prefers tool_use_id when available', () => {
		const key = buildDedupKey({
			runnerKind: 'bun',
			operation: 'runTests',
			toolUseId: 'toolu_123',
			target: '.',
		})
		expect(key).toBe('bun|runTests|toolu_123')
	})

	test('uses target fallback without tool_use_id', () => {
		const key = buildDedupKey({
			runnerKind: 'tsc',
			operation: 'typecheck',
			target: 'packages/tsc-runner',
		})
		expect(key).toBe('tsc|typecheck|packages/tsc-runner')
		expect(hashDedupKey(key)).toHaveLength(64)
	})
})
