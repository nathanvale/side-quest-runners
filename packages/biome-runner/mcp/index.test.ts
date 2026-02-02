import { describe, expect, test } from 'bun:test'
import { parseBiomeOutput } from './index'

describe('parseBiomeOutput', () => {
	test('parses empty diagnostics', () => {
		const result = parseBiomeOutput(
			JSON.stringify({ diagnostics: [], summary: { errors: 0, warnings: 0 } }),
		)
		expect(result.error_count).toBe(0)
		expect(result.warning_count).toBe(0)
		expect(result.diagnostics).toHaveLength(0)
	})

	test('parses error diagnostics', () => {
		const result = parseBiomeOutput(
			JSON.stringify({
				diagnostics: [
					{
						severity: 'error',
						location: { path: { file: 'src/index.ts' }, span: { start: { line: 10 } } },
						description: 'Use === instead of ==',
						category: 'lint/suspicious/noDoubleEquals',
					},
				],
				summary: { errors: 1, warnings: 0 },
			}),
		)
		expect(result.error_count).toBe(1)
		expect(result.diagnostics).toHaveLength(1)
		expect(result.diagnostics[0]?.file).toBe('src/index.ts')
		expect(result.diagnostics[0]?.code).toBe('lint/suspicious/noDoubleEquals')
	})

	test('handles invalid JSON gracefully', () => {
		const result = parseBiomeOutput('not json')
		expect(result.error_count).toBe(1)
		expect(result.diagnostics[0]?.code).toBe('internal_error')
	})
})
