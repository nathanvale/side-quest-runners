// Intentional TypeScript errors for TOON spike
const x: number = 'hello'
const y: string = 42
const z: boolean = { foo: 'bar' }
function add(a: number, b: number): number {
	return a + b
}
add('one', 'two')
add(1, 2, 3)
const arr: number[] = [1, 'two', 3, 'four', 5]
const obj: { name: string; age: number } = { name: 123, age: 'old' }
interface User {
	id: number
	email: string
}
const user: User = { id: 'abc', email: 456 }
const missing: User = { id: 1 }
const extra: User = { id: 1, email: 'test', role: 'admin' }
