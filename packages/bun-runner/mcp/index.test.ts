import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
	_resetGitRootCache,
	compactSummaryForJsonText,
	createBunCoverageInvocation,
	createBunInvocation,
	createBunServer,
	createIdleShutdownWatcher,
	createIdleShutdownWatcherFromEnv,
	createParentLivenessWatcher,
	DEFAULT_IDLE_EXIT_MS,
	DEFAULT_PARENT_CHECK_MS,
	extractTopStackFrame,
	MIN_IDLE_EXIT_MS,
	MIN_PARENT_CHECK_MS,
	parseIdleExitMs,
	parseParentCheckMs,
	resolvePathContext,
	SERVER_VERSION,
	spawnWithTimeout,
	validatePath,
	validateShellSafePattern,
} from './index'
import { parseBunTestOutput } from './parse-utils'

async function runGit(args: string[], cwd = process.cwd()): Promise<void> {
	const proc = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${exitCode}): ${stdout}${stderr}`)
	}
}

async function createLinkedWorktree(prefix: string): Promise<{
	worktree: string
	cleanup: () => Promise<void>
}> {
	const parent = await mkdtemp(path.join(tmpdir(), `${prefix}-`))
	const worktree = path.join(parent, 'checkout')
	await runGit(['worktree', 'add', '--detach', worktree, 'HEAD'])
	return {
		worktree,
		cleanup: async () => {
			await runGit(['worktree', 'remove', '--force', worktree]).catch(() => undefined)
			await rm(parent, { recursive: true, force: true })
		},
	}
}

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

describe('token-efficiency helpers', () => {
	test('extractTopStackFrame returns first stack frame line', () => {
		const top = extractTopStackFrame(
			'Error: boom\n    at alpha (/tmp/a.ts:10:3)\n    at beta (/tmp/b.ts:20:5)',
		)
		expect(top).toBe('at alpha (/tmp/a.ts:10:3)')
	})

	test('compactSummaryForJsonText deduplicates common file path', () => {
		const compact = compactSummaryForJsonText({
			passed: 1,
			failed: 2,
			total: 3,
			failures: [
				{
					file: '/tmp/fail.test.ts',
					message: 'first failure',
					line: 10,
					stack: null,
				},
				{
					file: '/tmp/fail.test.ts',
					message: 'second failure',
					line: 20,
					stack: null,
				},
			],
		})

		expect(compact).toMatchInlineSnapshot(`
			{
			  "commonFile": "/tmp/fail.test.ts",
			  "failed": 2,
			  "failures": [
			    {
			      "line": 10,
			      "message": "first failure",
			    },
			    {
			      "line": 20,
			      "message": "second failure",
			    },
			  ],
			  "passed": 1,
			  "total": 3,
			}
		`)
	})
})

describe('validation helpers', () => {
	test('rejects path null bytes', async () => {
		await expect(validatePath('packages/bun-runner\x00')).rejects.toThrow('Path contains null byte')
	})

	test('rejects control characters', async () => {
		await expect(validatePath('packages/bun-runner\n')).rejects.toThrow(
			'Path contains control characters',
		)
	})

	test('rejects traversal paths outside repository', async () => {
		await expect(validatePath('../../../etc/passwd')).rejects.toThrow(
			'Path outside configured runner repository or linked worktrees',
		)
	})

	test('rejects symlink escape outside repository', async () => {
		const linkPath = path.join(process.cwd(), 'tmp-bun-outside-link')
		await rm(linkPath, { force: true })
		await symlink('/tmp', linkPath)
		try {
			await expect(validatePath(linkPath)).rejects.toThrow(
				'Path outside configured runner repository or linked worktrees',
			)
		} finally {
			await rm(linkPath, { force: true })
		}
	})

	test('accepts paths in linked worktrees for the same repository', async () => {
		_resetGitRootCache()
		const { worktree, cleanup } = await createLinkedWorktree('bun-runner-linked-worktree')
		try {
			const packagePath = path.join(worktree, 'package.json')
			const context = await resolvePathContext(packagePath)

			expect(context.realPath).toBe(await realpath(packagePath))
			expect(context.worktreeRoot).toBe(await realpath(worktree))
		} finally {
			await cleanup()
		}
	})

	test('accepts missing paths under linked worktrees via nearest ancestor', async () => {
		_resetGitRootCache()
		const { worktree, cleanup } = await createLinkedWorktree('bun-runner-missing-linked-worktree')
		try {
			const missingPath = path.join(worktree, 'reports', 'future.test.ts')
			const context = await resolvePathContext(missingPath)

			expect(context.realPath).toBe(
				path.join(await realpath(worktree), 'reports', 'future.test.ts'),
			)
			expect(context.worktreeRoot).toBe(await realpath(worktree))
		} finally {
			await cleanup()
		}
	})

	test('rejects file paths when a directory is required', async () => {
		await expect(resolvePathContext('package.json', { requireDirectory: true })).rejects.toThrow(
			'cwd must resolve to a directory',
		)
	})

	test('rejects paths in unrelated git repositories', async () => {
		_resetGitRootCache()
		const unrelatedRepo = await mkdtemp(path.join(tmpdir(), 'bun-runner-unrelated-repo-'))
		try {
			await runGit(['init'], unrelatedRepo)
			const filePath = path.join(unrelatedRepo, 'index.ts')
			await writeFile(filePath, 'export const value = 1;\n')

			await expect(validatePath(filePath)).rejects.toThrow(
				'Path outside configured runner repository or linked worktrees',
			)
		} finally {
			await rm(unrelatedRepo, { recursive: true, force: true })
		}
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
			expect(invocation.cmd).toEqual(['bun', 'test', '--test-name-pattern', 'auth'])
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

	test('uses positional arguments for path-like file patterns', () => {
		expect(createBunInvocation('login.test.ts').cmd).toEqual(['bun', 'test', '--', 'login.test.ts'])
		expect(createBunInvocation('tests/login.ts').cmd).toEqual([
			'bun',
			'test',
			'--',
			'tests/login.ts',
		])
	})
})

describe('spawnWithTimeout', () => {
	test('returns timedOut=true for long-running subprocesses', async () => {
		const result = await spawnWithTimeout(['bun', '-e', 'setInterval(() => {}, 1000)'], 50)

		expect(result.timedOut).toBe(true)
		expect(typeof result.stdout).toBe('string')
		expect(typeof result.stderr).toBe('string')
	})

	test('truncates oversized stdout when maxBytes is exceeded', async () => {
		const result = await spawnWithTimeout(['bun', '-e', 'console.log("x".repeat(10_000))'], 5_000, {
			maxBytes: 128,
		})

		expect(result.timedOut).toBe(false)
		expect(result.stdoutTruncated).toBe(true)
		expect(result.stdout.length).toBeLessThanOrEqual(128)
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
			expect(runTests?.inputSchema.properties?.cwd).toBeDefined()

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
			expect(testCoverage?.inputSchema.properties?.cwd).toBeDefined()
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
				cwd: string
				passed: number
				failed: number
				total: number
				failures: Array<{ file: string; message: string; line: number | null }>
			}

			expect(typeof summary.cwd).toBe('string')
			expect(typeof summary.passed).toBe('number')
			expect(typeof summary.failed).toBe('number')
			expect(typeof summary.total).toBe('number')
			expect(Array.isArray(summary.failures)).toBe(true)

			const text = result.content[0]?.text
			expect(typeof text).toBe('string')
			expect(JSON.parse(text as string).cwd).toBe(summary.cwd)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('bun_testFile runs linked-worktree files from that worktree cwd', async () => {
		_resetGitRootCache()
		const { worktree, cleanup } = await createLinkedWorktree('bun-runner-tool-linked-worktree')
		const fixtureDir = path.join(worktree, 'reports', 'bun-linked-fixture')
		await mkdir(fixtureDir, { recursive: true })
		const fixtureFile = path.join(fixtureDir, 'pass.test.ts')
		await writeFile(
			fixtureFile,
			"import { expect, test } from 'bun:test';\ntest('linked file pass', () => expect(1 + 1).toBe(2));\n",
		)

		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'bun_testFile',
				arguments: {
					file: fixtureFile,
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			const output = result.structuredContent as {
				cwd: string
				failed: number
				total: number
			}
			expect(output.cwd).toBe(await realpath(worktree))
			expect(output.failed).toBe(0)
			expect(output.total).toBe(1)
			expect(JSON.parse(result.content[0]?.text as string).cwd).toBe(output.cwd)
		} finally {
			await Promise.all([client.close(), server.close()])
			await cleanup()
		}
	})

	test('bun_runTests accepts linked-worktree cwd for name filters', async () => {
		_resetGitRootCache()
		const { worktree, cleanup } = await createLinkedWorktree('bun-runner-cwd-linked-worktree')
		const fixtureDir = path.join(worktree, 'reports', 'bun-cwd-fixture')
		await mkdir(fixtureDir, { recursive: true })
		await writeFile(
			path.join(fixtureDir, 'pass.test.ts'),
			"import { expect, test } from 'bun:test';\ntest('linked cwd unique pass', () => expect(true).toBe(true));\n",
		)

		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'bun_runTests',
				arguments: {
					cwd: fixtureDir,
					pattern: 'linked cwd unique pass',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			const output = result.structuredContent as {
				cwd: string
				failed: number
				total: number
			}
			expect(output.cwd).toBe(await realpath(fixtureDir))
			expect(output.failed).toBe(0)
			expect(output.total).toBe(1)
		} finally {
			await Promise.all([client.close(), server.close()])
			await cleanup()
		}
	})

	test('bun_runTests preserves subdirectory cwd for path patterns', async () => {
		_resetGitRootCache()
		const fixtureDir = path.join(process.cwd(), 'reports', 'bun-subdir-cwd-fixture')
		await rm(fixtureDir, { recursive: true, force: true })
		await mkdir(path.join(fixtureDir, 'tests'), { recursive: true })
		await writeFile(
			path.join(fixtureDir, 'tests', 'pass.test.ts'),
			"import { expect, test } from 'bun:test';\ntest('subdir cwd unique pass', () => expect(true).toBe(true));\n",
		)

		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'bun_runTests',
				arguments: {
					cwd: fixtureDir,
					pattern: 'tests/pass.test.ts',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			const output = result.structuredContent as {
				cwd: string
				failed: number
				total: number
			}
			expect(output.cwd).toBe(await realpath(fixtureDir))
			expect(output.failed).toBe(0)
			expect(output.total).toBe(1)
		} finally {
			await Promise.all([client.close(), server.close()])
			await rm(fixtureDir, { recursive: true, force: true })
		}
	})

	test('bun_runTests rejects file paths as cwd', async () => {
		_resetGitRootCache()
		const server = await createBunServer()
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'bun_runTests',
				arguments: {
					cwd: 'package.json',
					pattern: 'nonesuchpattern',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(true)
			expect(result.content[0]?.text).toContain('CWD_INVALID')
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('bun_runTests rejects cwd and path pattern from different worktrees', async () => {
		_resetGitRootCache()
		const first = await createLinkedWorktree('bun-runner-mixed-first')
		const second = await createLinkedWorktree('bun-runner-mixed-second')
		try {
			const server = await createBunServer()
			const client = new Client({ name: 'bun-client', version: '0.0.1' })
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

			await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

			try {
				const result = await client.callTool({
					name: 'bun_runTests',
					arguments: {
						cwd: first.worktree,
						pattern: path.join(second.worktree, 'package.json'),
						response_format: 'json',
					},
				})

				expect(result.isError).toBe(true)
				expect(result.content[0]?.text).toContain('PATTERN_INVALID')
			} finally {
				await Promise.all([client.close(), server.close()])
			}
		} finally {
			await first.cleanup()
			await second.cleanup()
		}
	})

	test('tool calls and logging/setLevel are tracked as request activity', async () => {
		_resetGitRootCache()
		const activityEvents: string[] = []
		const server = await createBunServer({
			onRequestStart: () => {
				activityEvents.push('start')
				return () => activityEvents.push('finish')
			},
		})
		const client = new Client({ name: 'bun-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const expectToolActivity = async (name: string, toolArguments: Record<string, unknown>) => {
				activityEvents.length = 0
				await client.callTool({
					name,
					arguments: toolArguments,
				})
				expect(activityEvents).toEqual(['start', 'finish'])
			}

			// Discovery alone should not keep an abandoned runner alive.
			await client.listTools()
			expect(activityEvents).toEqual([])

			await expectToolActivity('bun_runTests', {
				pattern: 'nonesuchpattern',
				response_format: 'json',
			})
			await expectToolActivity('bun_testFile', {
				file: 'definitely-missing.test.ts',
				response_format: 'json',
			})

			activityEvents.length = 0
			await client.setLoggingLevel('info')
			expect(activityEvents).toEqual(['start', 'finish'])
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

describe('parseParentCheckMs', () => {
	test('returns default when env is undefined', () => {
		expect(parseParentCheckMs(undefined)).toBe(DEFAULT_PARENT_CHECK_MS)
	})

	test('returns default for empty / whitespace string', () => {
		expect(parseParentCheckMs('')).toBe(DEFAULT_PARENT_CHECK_MS)
		expect(parseParentCheckMs('   ')).toBe(DEFAULT_PARENT_CHECK_MS)
	})

	test('returns default for non-numeric / NaN values', () => {
		expect(parseParentCheckMs('abc')).toBe(DEFAULT_PARENT_CHECK_MS)
		expect(parseParentCheckMs('NaN')).toBe(DEFAULT_PARENT_CHECK_MS)
	})

	test('returns 0 (disabled) for zero', () => {
		expect(parseParentCheckMs('0')).toBe(0)
	})

	test('returns 0 (disabled) for negative values', () => {
		expect(parseParentCheckMs('-1')).toBe(0)
		expect(parseParentCheckMs('-9999')).toBe(0)
	})

	test('clamps tiny positive values up to MIN_PARENT_CHECK_MS', () => {
		expect(parseParentCheckMs('1')).toBe(MIN_PARENT_CHECK_MS)
		expect(parseParentCheckMs('49')).toBe(MIN_PARENT_CHECK_MS)
	})

	test('passes through values at or above the minimum', () => {
		expect(parseParentCheckMs('50')).toBe(50)
		expect(parseParentCheckMs('200')).toBe(200)
		expect(parseParentCheckMs('5000')).toBe(5000)
	})
})

describe('parseIdleExitMs', () => {
	test('returns default disabled value when env is undefined', () => {
		expect(DEFAULT_IDLE_EXIT_MS).toBe(0)
		expect(parseIdleExitMs(undefined)).toBe(DEFAULT_IDLE_EXIT_MS)
	})

	test('returns default disabled value for empty / whitespace string', () => {
		expect(parseIdleExitMs('')).toBe(DEFAULT_IDLE_EXIT_MS)
		expect(parseIdleExitMs('   ')).toBe(DEFAULT_IDLE_EXIT_MS)
	})

	test('returns default disabled value for non-numeric / NaN values', () => {
		expect(parseIdleExitMs('abc')).toBe(DEFAULT_IDLE_EXIT_MS)
		expect(parseIdleExitMs('NaN')).toBe(DEFAULT_IDLE_EXIT_MS)
	})

	test('returns 0 (disabled) for zero and negative values', () => {
		expect(parseIdleExitMs('0')).toBe(0)
		expect(parseIdleExitMs('-1')).toBe(0)
	})

	test('clamps tiny positive values up to MIN_IDLE_EXIT_MS', () => {
		expect(parseIdleExitMs('1')).toBe(MIN_IDLE_EXIT_MS)
		expect(parseIdleExitMs('49')).toBe(MIN_IDLE_EXIT_MS)
	})

	test('passes through values at or above the minimum', () => {
		expect(parseIdleExitMs('50')).toBe(50)
		expect(parseIdleExitMs('200')).toBe(200)
		expect(parseIdleExitMs('900000')).toBe(900_000)
	})
})

describe('createIdleShutdownWatcherFromEnv', () => {
	test('leaves idle shutdown disabled when env is omitted', () => {
		const calls: number[] = []
		const result = createIdleShutdownWatcherFromEnv({
			env: {},
			onIdle: () => {},
			createWatcher: (opts) => {
				calls.push(opts.idleMs)
				return undefined
			},
		})

		expect(result.idleMs).toBe(DEFAULT_IDLE_EXIT_MS)
		expect(result.watcher).toBeUndefined()
		expect(calls).toEqual([DEFAULT_IDLE_EXIT_MS])
	})

	test('passes zero through so the watcher can be disabled', () => {
		const calls: number[] = []
		const result = createIdleShutdownWatcherFromEnv({
			env: { MCP_IDLE_EXIT_MS: '0' },
			onIdle: () => {},
			createWatcher: (opts) => {
				calls.push(opts.idleMs)
				return undefined
			},
		})

		expect(result.idleMs).toBe(0)
		expect(result.watcher).toBeUndefined()
		expect(calls).toEqual([0])
	})
})

describe('createIdleShutdownWatcher', () => {
	test('returns undefined when idleMs <= 0 (disabled)', () => {
		expect(
			createIdleShutdownWatcher({
				idleMs: 0,
				onIdle: () => {
					throw new Error('should not be called')
				},
			}),
		).toBeUndefined()
		expect(
			createIdleShutdownWatcher({
				idleMs: -1,
				onIdle: () => {
					throw new Error('should not be called')
				},
			}),
		).toBeUndefined()
	})

	test('calls .unref() on the idle timer handle', () => {
		const probe = setTimeout(() => {}, 60_000)
		const timerProto = Object.getPrototypeOf(probe) as { unref: () => void }
		clearTimeout(probe)
		const unrefSpy = spyOn(timerProto, 'unref')
		try {
			const watcher = createIdleShutdownWatcher({
				idleMs: 60_000,
				onIdle: () => {
					throw new Error('should not be called')
				},
			})
			expect(watcher).toBeDefined()
			expect(unrefSpy).toHaveBeenCalledTimes(1)
			watcher?.stop()
		} finally {
			unrefSpy.mockRestore()
		}
	})

	test('invokes onIdle once after inactivity', async () => {
		let calls = 0
		const watcher = createIdleShutdownWatcher({
			idleMs: 50,
			onIdle: () => {
				calls += 1
			},
		})
		try {
			await new Promise((resolve) => setTimeout(resolve, 140))
			expect(calls).toBe(1)
		} finally {
			watcher?.stop()
		}
	})

	test('does not invoke onIdle while a request is active', async () => {
		let calls = 0
		const watcher = createIdleShutdownWatcher({
			idleMs: 50,
			onIdle: () => {
				calls += 1
			},
		})
		const finishRequest = watcher?.recordRequestStart()
		try {
			await new Promise((resolve) => setTimeout(resolve, 140))
			expect(calls).toBe(0)
		} finally {
			finishRequest?.()
			watcher?.stop()
		}
	})

	test('reschedules idle shutdown after active request finishes', async () => {
		let calls = 0
		const watcher = createIdleShutdownWatcher({
			idleMs: 50,
			onIdle: () => {
				calls += 1
			},
		})
		const finishRequest = watcher?.recordRequestStart()
		try {
			await new Promise((resolve) => setTimeout(resolve, 90))
			expect(calls).toBe(0)
			finishRequest?.()
			await new Promise((resolve) => setTimeout(resolve, 90))
			expect(calls).toBe(1)
		} finally {
			watcher?.stop()
		}
	})

	test('waits for all concurrent requests and ignores duplicate finishes', async () => {
		let calls = 0
		const watcher = createIdleShutdownWatcher({
			idleMs: 50,
			onIdle: () => {
				calls += 1
			},
		})
		const finishFirst = watcher?.recordRequestStart()
		const finishSecond = watcher?.recordRequestStart()
		try {
			finishFirst?.()
			finishFirst?.()
			await new Promise((resolve) => setTimeout(resolve, 90))
			expect(calls).toBe(0)
			finishSecond?.()
			await new Promise((resolve) => setTimeout(resolve, 90))
			expect(calls).toBe(1)
		} finally {
			watcher?.stop()
		}
	})

	test('stop prevents later idle shutdown', async () => {
		let calls = 0
		const watcher = createIdleShutdownWatcher({
			idleMs: 50,
			onIdle: () => {
				calls += 1
			},
		})
		watcher?.stop()
		await new Promise((resolve) => setTimeout(resolve, 120))
		expect(calls).toBe(0)
	})
})

describe('createParentLivenessWatcher', () => {
	test('returns undefined when intervalMs <= 0 (disabled)', () => {
		const onParentDeath = () => {
			throw new Error('should not be called')
		}
		expect(
			createParentLivenessWatcher({
				initialPpid: 1234,
				getPpid: () => 1234,
				onParentDeath,
				intervalMs: 0,
			}),
		).toBeUndefined()
		expect(
			createParentLivenessWatcher({
				initialPpid: 1234,
				getPpid: () => 1234,
				onParentDeath,
				intervalMs: -1,
			}),
		).toBeUndefined()
	})

	test('calls .unref() on the timer handle so it does not block the loop', () => {
		// Spy on the Timer prototype's unref so we observe the real call made
		// by createParentLivenessWatcher. A timing-based assertion would still
		// pass if unref() were silently removed, because clearInterval also
		// lets bun:test exit promptly.
		const probe = setInterval(() => {}, 60_000)
		const timerProto = Object.getPrototypeOf(probe) as { unref: () => void }
		clearInterval(probe)
		const unrefSpy = spyOn(timerProto, 'unref')
		try {
			const handle = createParentLivenessWatcher({
				initialPpid: 1234,
				getPpid: () => 1234,
				onParentDeath: () => {
					throw new Error('should not be called when ppid unchanged')
				},
				intervalMs: 60_000,
			})
			expect(handle).toBeDefined()
			expect(unrefSpy).toHaveBeenCalledTimes(1)
			clearInterval(handle as ReturnType<typeof setInterval>)
		} finally {
			unrefSpy.mockRestore()
		}
	})

	test('does not invoke onParentDeath while ppid is unchanged', async () => {
		let calls = 0
		const handle = createParentLivenessWatcher({
			initialPpid: 1234,
			getPpid: () => 1234,
			onParentDeath: () => {
				calls += 1
			},
			intervalMs: 50,
		})
		try {
			await new Promise((resolve) => setTimeout(resolve, 180))
			expect(calls).toBe(0)
		} finally {
			clearInterval(handle as ReturnType<typeof setInterval>)
		}
	})

	test('invokes onParentDeath once when ppid changes from initial', async () => {
		let currentPpid = 1234
		let calls = 0
		const handle = createParentLivenessWatcher({
			initialPpid: 1234,
			getPpid: () => currentPpid,
			onParentDeath: () => {
				calls += 1
			},
			intervalMs: 50,
		})
		try {
			await new Promise((resolve) => setTimeout(resolve, 80))
			expect(calls).toBe(0)
			currentPpid = 1
			await new Promise((resolve) => setTimeout(resolve, 180))
			expect(calls).toBe(1)
		} finally {
			clearInterval(handle as ReturnType<typeof setInterval>)
		}
	})

	test('invokes onParentDeath once when initial parent process is gone', async () => {
		let calls = 0
		const handle = createParentLivenessWatcher({
			initialPpid: 1234,
			getPpid: () => 1234,
			isParentAlive: () => false,
			onParentDeath: () => {
				calls += 1
			},
			intervalMs: 50,
		})
		try {
			await new Promise((resolve) => setTimeout(resolve, 180))
			expect(calls).toBe(1)
		} finally {
			clearInterval(handle as ReturnType<typeof setInterval>)
		}
	})

	test('does not invoke onParentDeath when ppid starts and remains 1', async () => {
		let calls = 0
		const handle = createParentLivenessWatcher({
			initialPpid: 1,
			getPpid: () => 1,
			onParentDeath: () => {
				calls += 1
			},
			intervalMs: 50,
		})
		try {
			await new Promise((resolve) => setTimeout(resolve, 120))
			expect(calls).toBe(0)
		} finally {
			clearInterval(handle as ReturnType<typeof setInterval>)
		}
	})
})
