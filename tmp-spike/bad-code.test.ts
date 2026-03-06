import { describe, test, expect } from 'bun:test'

describe('TOON spike - intentional failures', () => {
	test('string equality fails', () => {
		expect('hello').toBe('world')
	})

	test('number comparison fails', () => {
		expect(42).toBe(99)
	})

	test('array equality fails', () => {
		expect([1, 2, 3]).toEqual([1, 2, 4])
	})

	test('object equality fails', () => {
		expect({ name: 'Alice', age: 30 }).toEqual({ name: 'Bob', age: 25 })
	})

	test('truthy check fails', () => {
		expect(0).toBeTruthy()
	})

	test('this one passes', () => {
		expect(1 + 1).toBe(2)
	})

	test('type error in test', () => {
		const result = JSON.parse('{"count": 5}')
		expect(result.count).toBe('5')
	})

	test('throw check fails', () => {
		expect(() => {
			return 'no throw'
		}).toThrow()
	})
})
