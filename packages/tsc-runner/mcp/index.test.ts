import { describe, expect, test } from 'bun:test'
import { parseTscOutput } from './index'

describe('parseTscOutput', () => {
	test('parses TypeScript errors', () => {
		const output = `src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/utils.ts(20,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`

		const result = parseTscOutput(output)

		expect(result.errorCount).toBe(2)
		expect(result.errors[0]?.file).toBe('src/index.ts')
		expect(result.errors[0]?.line).toBe(10)
		expect(result.errors[0]?.col).toBe(5)
		expect(result.errors[0]?.message).toContain("Type 'string'")
		expect(result.errors[1]?.file).toBe('src/utils.ts')
		expect(result.errors[1]?.line).toBe(20)
	})

	test('handles clean output (no errors)', () => {
		const result = parseTscOutput('')
		expect(result.errorCount).toBe(0)
		expect(result.errors).toHaveLength(0)
	})

	test('handles output with warnings but no errors', () => {
		const result = parseTscOutput('Some warning text\nAnother line')
		expect(result.errorCount).toBe(0)
		expect(result.errors).toHaveLength(0)
	})
})
