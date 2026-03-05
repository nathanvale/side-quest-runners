import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
	_resetGitRootCache,
	createBunCoverageInvocation,
	createBunInvocation,
	createBunServer,
	SERVER_VERSION,
	spawnWithTimeout,
	validatePath,
	validateShellSafePattern,
} from './index'
import { parseBunTestOutput } from './parse-utils'

describe('parseBunTestOutput', () => {
	test('parses all passing tests', () => {
		const output = `bun test v1.3.2

 3 pass
 0 fail
 5 expect() calls
Ran 3 tests across 1 file. [50.00ms]`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(3)
		expect(result.failed).toBe(0)
		expect(result.total).toBe(3)
		expect(result.failures).toHaveLength(0)
	})

	test('parses failing tests with pass/fail summary', () => {
		const output = `bun test v1.3.2

✗ should add numbers [1.23ms]
  error: expect(received).toBe(expected)
  Expected: 5
  Received: 4
      at /path/to/math.test.ts:10:5

 2 pass
 1 fail
 3 expect() calls
Ran 3 tests across 1 file. [50.00ms]`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(2)
		expect(result.failed).toBe(1)
		expect(result.total).toBe(3)
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0]?.file).toBe('/path/to/math.test.ts')
		expect(result.failures[0]?.line).toBe(10)
		expect(result.failures[0]?.message).toContain('✗ should add numbers')
	})

	test('parses multiple failures', () => {
		const output = `bun test v1.3.2

✗ test one [1.00ms]
  error: first error
      at /path/to/one.test.ts:5:3

✗ test two [2.00ms]
  error: second error
      at /path/to/two.test.ts:15:7

 0 pass
 2 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(0)
		expect(result.failed).toBe(2)
		expect(result.failures).toHaveLength(2)
		expect(result.failures[0]?.file).toBe('/path/to/one.test.ts')
		expect(result.failures[0]?.line).toBe(5)
		expect(result.failures[1]?.file).toBe('/path/to/two.test.ts')
		expect(result.failures[1]?.line).toBe(15)
	})

	test('handles FAIL keyword', () => {
		const output = `FAIL src/index.test.ts
  error: something went wrong

 0 pass
 1 fail`

		const result = parseBunTestOutput(output)

		expect(result.failed).toBe(1)
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0]?.message).toContain('FAIL')
	})

	test('handles empty output', () => {
		const result = parseBunTestOutput('')

		expect(result.passed).toBe(0)
		expect(result.failed).toBe(0)
		expect(result.total).toBe(0)
		expect(result.failures).toHaveLength(0)
	})

	test('extracts stack traces', () => {
		const output = `✗ my test
  error: oops
      at someFunc (/path/file.ts:10:5)
      at anotherFunc (/path/other.ts:20:10)

 0 pass
 1 fail`

		const result = parseBunTestOutput(output)

		expect(result.failures[0]?.stack).toContain('at someFunc')
		expect(result.failures[0]?.stack).toContain('at anotherFunc')
	})

	test('parses Bun v1.3+ format with (fail) marker', () => {
		// Bun v1.3+ shows error/diff first, then stack, then (fail) marker
		const output = `bun test v1.3.3 (274e01c7)

.test-scratch/test-standard/fail.test.ts:
1 | import { expect, test } from "bun:test";
2 |
3 | test("should fail", () => {
4 |   expect({ name: "Alice" }).toEqual({ name: "Bob" });
                                ^
error: expect(received).toEqual(expected)

  {
-   "name": "Bob",
+   "name": "Alice",
  }

- Expected  - 1
+ Received  + 1

      at <anonymous> (/path/to/fail.test.ts:4:38)
(fail) should fail [0.21ms]

 0 pass
 1 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(0)
		expect(result.failed).toBe(1)
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0]?.file).toBe('/path/to/fail.test.ts')
		expect(result.failures[0]?.line).toBe(4)
		expect(result.failures[0]?.message).toContain('should fail')
		expect(result.failures[0]?.message).toContain('expect(received).toEqual(expected)')
		expect(result.failures[0]?.message).toContain('"name": "Alice"')
	})

	test('parses multiple failures in Bun v1.3+ format', () => {
		const output = `bun test v1.3.3 (274e01c7)

error: expect(received).toEqual(expected)
Expected: 5
Received: 4

      at <anonymous> (/path/to/math.test.ts:10:5)
(fail) test one [0.10ms]

error: expect(received).toBe(expected)
Expected: "hello"
Received: "world"

      at <anonymous> (/path/to/string.test.ts:20:8)
(fail) test two [0.05ms]

 0 pass
 2 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(0)
		expect(result.failed).toBe(2)
		expect(result.failures).toHaveLength(2)
		expect(result.failures[0]?.file).toBe('/path/to/math.test.ts')
		expect(result.failures[0]?.line).toBe(10)
		expect(result.failures[0]?.message).toContain('test one')
		expect(result.failures[1]?.file).toBe('/path/to/string.test.ts')
		expect(result.failures[1]?.line).toBe(20)
		expect(result.failures[1]?.message).toContain('test two')
	})

	test('ignores console.error output when summary shows 0 fail', () => {
		// This is the key fix for issue #11 - console.error from tests
		// should not create spurious failures when summary says 0 fail
		const output = `bun test v1.3.2

error: Logging is broken
error: Another console.error message
(pass) instrumentation > test [1.00ms]

 3 pass
 0 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(3)
		expect(result.failed).toBe(0)
		expect(result.failures).toHaveLength(0)
	})

	test('captures real failures even when console.error is present', () => {
		const output = `bun test v1.3.2

error: Console noise before test
error: assertion failed
Expected: 5
Received: 4
      at /path/test.ts:10:5
(fail) actual failing test [1.00ms]

 2 pass
 1 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(2)
		expect(result.failed).toBe(1)
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0]?.message).toContain('actual failing test')
	})

	test('handles v1.3+ format with mixed (pass) and (fail) markers', () => {
		const output = `bun test v1.3.3

error: Logging is broken
(pass) test one [1.00ms]
error: actual test error
      at /path/fail.ts:5:3
(fail) test two [2.00ms]

 1 pass
 1 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(1)
		expect(result.failed).toBe(1)
		expect(result.failures).toHaveLength(1)
		expect(result.failures[0]?.file).toBe('/path/fail.ts')
	})

	test('discards orphan error: blocks without (fail) marker in v1.3+ format', () => {
		// Orphan error: lines that are never terminated by (fail)
		// should be discarded as they're likely console.error output
		const output = `bun test v1.3.2

error: This is console.error output
Some additional logging
(pass) passing test [1.00ms]

 1 pass
 0 fail`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(1)
		expect(result.failed).toBe(0)
		expect(result.failures).toHaveLength(0)
	})

	test('handles large test suite with console.error noise', () => {
		// Simulates the real-world scenario from side-quest-marketplace
		// where 3387 tests pass but console.error creates false positives
		const output = `bun test v1.3.2

error: Logging is broken
error: Warning: some deprecation notice
(pass) test 1 [0.01ms]
(pass) test 2 [0.01ms]
(pass) test 3 [0.01ms]

 3387 pass
 0 fail
Ran 3387 tests across 150 files. [25.00s]`

		const result = parseBunTestOutput(output)

		expect(result.passed).toBe(3387)
		expect(result.failed).toBe(0)
		expect(result.failures).toHaveLength(0)
	})
})

describe('validation helpers', () => {
	test('rejects path null bytes', async () => {
		await expect(validatePath('packages/bun-runner\x00')).rejects.toThrow('Path contains null byte')
	})

	test('rejects traversal paths outside repository', async () => {
		await expect(validatePath('../../../etc/passwd')).rejects.toThrow('Path outside repository')
	})

	test('rejects unsafe shell patterns', () => {
		expect(() => validateShellSafePattern('--preload=./malicious.ts')).toThrow(
			'Pattern must not start with a dash',
		)
		expect(() => validateShellSafePattern('$(whoami)')).toThrow(
			'Pattern contains unsafe characters',
		)
	})
})

describe('createBunInvocation', () => {
	test('applies strict env allowlist plus CI', () => {
		const previousNodePath = process.env.NODE_PATH
		const previousBunInstall = process.env.BUN_INSTALL
		const previousTmpdir = process.env.TMPDIR
		try {
			process.env.NODE_PATH = '/tmp/node-path'
			process.env.BUN_INSTALL = '/tmp/bun-install'
			process.env.TMPDIR = '/tmp'

			const invocation = createBunInvocation('auth')
			const keys = Object.keys(invocation.env)

			expect(keys.includes('CI')).toBe(true)
			expect(keys.includes('PATH')).toBe(true)
			expect(keys.includes('HOME')).toBe(true)
			expect(keys.includes('NODE_PATH')).toBe(true)
			expect(keys.includes('BUN_INSTALL')).toBe(true)
			expect(keys.includes('TMPDIR')).toBe(true)
			expect(keys.includes('AWS_SECRET_ACCESS_KEY')).toBe(false)
			expect(keys.includes('GITHUB_TOKEN')).toBe(false)
			expect(invocation.cmd).toEqual(['bun', 'test', '--', 'auth'])
		} finally {
			if (previousNodePath === undefined) {
				delete process.env.NODE_PATH
			} else {
				process.env.NODE_PATH = previousNodePath
			}
			if (previousBunInstall === undefined) {
				delete process.env.BUN_INSTALL
			} else {
				process.env.BUN_INSTALL = previousBunInstall
			}
			if (previousTmpdir === undefined) {
				delete process.env.TMPDIR
			} else {
				process.env.TMPDIR = previousTmpdir
			}
		}
	})

	test('builds coverage command with Bun coverage flag', () => {
		const invocation = createBunCoverageInvocation()
		expect(invocation.cmd).toEqual(['bun', 'test', '--coverage'])
	})
})

describe('spawnWithTimeout', () => {
	test('returns timedOut=true for long-running subprocesses', async () => {
		const result = await spawnWithTimeout(['bun', '-e', 'setInterval(() => {}, 1000)'], 50)

		expect(result.timedOut).toBe(true)
		expect(typeof result.stdout).toBe('string')
		expect(typeof result.stderr).toBe('string')
	})
})

describe('bun tools integration', () => {
	test('syncs MCP server version with package.json', () => {
		const packageJson = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { version: string }

		expect(SERVER_VERSION).toBe(packageJson.version)
	})

	test('exposes all three tools via tools/list', async () => {
		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const list = await client.listTools()

			const runTests = list.tools.find((entry) => entry.name === 'bun_runTests')
			expect(runTests).toBeDefined()
			expect(runTests?.title).toBe('Bun Test Runner')
			expect(runTests?.annotations?.readOnlyHint).toBe(true)
			expect(runTests?.outputSchema).toBeDefined()

			const testFile = list.tools.find((entry) => entry.name === 'bun_testFile')
			expect(testFile).toBeDefined()
			expect(testFile?.title).toBe('Bun Single File Test Runner')
			expect(testFile?.annotations?.readOnlyHint).toBe(true)
			expect(testFile?.outputSchema).toBeDefined()

			const testCoverage = list.tools.find((entry) => entry.name === 'bun_testCoverage')
			expect(testCoverage).toBeDefined()
			expect(testCoverage?.title).toBe('Bun Test Coverage Reporter')
			expect(testCoverage?.annotations?.readOnlyHint).toBe(true)
			expect(testCoverage?.outputSchema).toBeDefined()
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('callTool returns structuredContent for runTests', async () => {
		_resetGitRootCache()
		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'bun_runTests',
				arguments: {
					pattern: 'nonesuchpattern',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const summary = result.structuredContent as {
				passed: number
				failed: number
				total: number
				failures: Array<{ file: string; message: string; line: number | null }>
			}

			expect(typeof summary.passed).toBe('number')
			expect(typeof summary.failed).toBe('number')
			expect(typeof summary.total).toBe('number')
			expect(Array.isArray(summary.failures)).toBe(true)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('coverage output schema uses uncovered {file, percent} entries', async () => {
		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const list = await client.listTools()
			const testCoverage = list.tools.find((entry) => entry.name === 'bun_testCoverage')
			expect(testCoverage).toBeDefined()

			const schema = testCoverage?.outputSchema as {
				properties?: {
					coverage?: {
						properties?: {
							uncovered?: {
								items?: {
									properties?: { file?: unknown; percent?: unknown }
								}
							}
						}
					}
				}
			}

			expect(
				schema?.properties?.coverage?.properties?.uncovered?.items?.properties?.file,
			).toBeDefined()
			expect(
				schema?.properties?.coverage?.properties?.uncovered?.items?.properties?.percent,
			).toBeDefined()
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})
})
