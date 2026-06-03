import { describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
	_resetGitRootCache,
	compactLintFixResultForJsonText,
	compactLintSummaryForJsonText,
	createBiomeInvocation,
	createBiomeServer,
	createIdleShutdownWatcher,
	createIdleShutdownWatcherFromEnv,
	createParentLivenessWatcher,
	DEFAULT_IDLE_EXIT_MS,
	DEFAULT_PARENT_CHECK_MS,
	MIN_IDLE_EXIT_MS,
	MIN_PARENT_CHECK_MS,
	parseBiomeOutput,
	parseIdleExitMs,
	parseParentCheckMs,
	resolvePathContext,
	SERVER_VERSION,
	spawnWithTimeout,
	validatePath,
	validatePathOrDefault,
} from './index'

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

describe('parseBiomeOutput', () => {
	test('parses empty diagnostics', () => {
		const result = parseBiomeOutput(
			JSON.stringify({ diagnostics: [], summary: { errors: 0, warnings: 0 } }),
		)
		expect(result.errorCount).toBe(0)
		expect(result.warningCount).toBe(0)
		expect(result.diagnostics).toHaveLength(0)
	})

	test('parses error diagnostics', () => {
		const result = parseBiomeOutput(
			JSON.stringify({
				diagnostics: [
					{
						severity: 'error',
						location: {
							path: { file: 'src/index.ts' },
							span: { start: { line: 10 } },
						},
						description: 'Use === instead of ==',
						category: 'lint/suspicious/noDoubleEquals',
					},
				],
				summary: { errors: 1, warnings: 0 },
			}),
		)
		expect(result.errorCount).toBe(1)
		expect(result.diagnostics).toHaveLength(1)
		expect(result.diagnostics[0]?.file).toBe('src/index.ts')
		expect(result.diagnostics[0]?.code).toBe('lint/suspicious/noDoubleEquals')
	})

	test('handles invalid JSON gracefully', () => {
		const result = parseBiomeOutput('not json')
		expect(result.errorCount).toBe(1)
		expect(result.diagnostics[0]?.code).toBe('internal_error')
	})
})

describe('token-efficiency helpers', () => {
	test('compactLintSummaryForJsonText deduplicates common file path', () => {
		const compact = compactLintSummaryForJsonText({
			errorCount: 1,
			warningCount: 1,
			diagnostics: [
				{
					file: 'src/index.ts',
					line: 10,
					message: 'Use ===',
					code: 'lint/suspicious/noDoubleEquals',
					severity: 'error',
					suggestion: null,
				},
				{
					file: 'src/index.ts',
					line: 20,
					message: 'Unused variable',
					code: 'lint/correctness/noUnusedVariables',
					severity: 'warning',
					suggestion: null,
				},
			],
		})

		expect(compact).toMatchInlineSnapshot(`
			{
			  "commonFile": "src/index.ts",
			  "diagnostics": [
			    {
			      "code": "lint/suspicious/noDoubleEquals",
			      "line": 10,
			      "message": "Use ===",
			      "severity": "error",
			    },
			    {
			      "code": "lint/correctness/noUnusedVariables",
			      "line": 20,
			      "message": "Unused variable",
			      "severity": "warning",
			    },
			  ],
			  "errorCount": 1,
			  "warningCount": 1,
			}
		`)
	})

	test('compactLintFixResultForJsonText strips null suggestion fields', () => {
		const compact = compactLintFixResultForJsonText({
			fixed: 1,
			remaining: {
				errorCount: 1,
				warningCount: 0,
				diagnostics: [
					{
						file: 'src/index.ts',
						line: 3,
						message: 'Problem',
						code: 'lint/rule',
						severity: 'error',
						suggestion: null,
					},
				],
			},
		})

		expect(compact).toMatchInlineSnapshot(`
			{
			  "fixed": 1,
			  "remaining": {
			    "commonFile": "src/index.ts",
			    "diagnostics": [
			      {
			        "code": "lint/rule",
			        "line": 3,
			        "message": "Problem",
			        "severity": "error",
			      },
			    ],
			    "errorCount": 1,
			    "warningCount": 0,
			  },
			}
		`)
	})
})

describe('path validation', () => {
	test('rejects null bytes', async () => {
		await expect(validatePath('packages/biome-runner\x00')).rejects.toThrow(
			'Path contains null byte',
		)
	})

	test('defaults empty input to cwd', async () => {
		const resolved = await validatePathOrDefault('   ')
		expect(resolved.length).toBeGreaterThan(0)
	})

	test('rejects traversal paths outside repository', async () => {
		await expect(validatePath('../../../etc/passwd')).rejects.toThrow(
			'Path outside configured runner repository or linked worktrees',
		)
	})

	test('rejects symlink escape outside repository', async () => {
		const linkPath = path.join(process.cwd(), 'tmp-biome-outside-link')
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
		const { worktree, cleanup } = await createLinkedWorktree('biome-runner-linked-worktree')
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
		const { worktree, cleanup } = await createLinkedWorktree('biome-runner-missing-linked-worktree')
		try {
			const missingPath = path.join(worktree, 'reports', 'future.ts')
			const context = await resolvePathContext(missingPath)

			expect(context.realPath).toBe(path.join(await realpath(worktree), 'reports', 'future.ts'))
			expect(context.worktreeRoot).toBe(await realpath(worktree))
		} finally {
			await cleanup()
		}
	})

	test('rejects paths in unrelated git repositories', async () => {
		_resetGitRootCache()
		const unrelatedRepo = await mkdtemp(path.join(tmpdir(), 'biome-runner-unrelated-repo-'))
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
})

describe('createBiomeInvocation', () => {
	test('applies strict env allowlist plus CI', () => {
		const previousNodePath = process.env.NODE_PATH
		const previousBunInstall = process.env.BUN_INSTALL
		const previousTmpdir = process.env.TMPDIR
		try {
			process.env.NODE_PATH = '/tmp/node-path'
			process.env.BUN_INSTALL = '/tmp/bun-install'
			process.env.TMPDIR = '/tmp'

			const invocation = createBiomeInvocation({
				subcommand: 'check',
				path: 'packages/biome-runner',
				write: true,
			})
			const keys = Object.keys(invocation.env)

			expect(keys.includes('CI')).toBe(true)
			expect(keys.includes('PATH')).toBe(true)
			expect(keys.includes('HOME')).toBe(true)
			expect(keys.includes('NODE_PATH')).toBe(true)
			expect(keys.includes('BUN_INSTALL')).toBe(true)
			expect(keys.includes('TMPDIR')).toBe(true)
			expect(keys.includes('AWS_SECRET_ACCESS_KEY')).toBe(false)
			expect(keys.includes('GITHUB_TOKEN')).toBe(false)
			expect(invocation.cmd).toEqual([
				'bunx',
				'@biomejs/biome',
				'check',
				'--write',
				'--reporter=json',
				'--max-diagnostics=200',
				'packages/biome-runner',
			])
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
})

describe('spawnWithTimeout', () => {
	test('returns timedOut=true for long-running subprocesses', async () => {
		const result = await spawnWithTimeout(['bun', '-e', 'setInterval(() => {}, 1000)'], {
			timeoutMs: 50,
		})

		expect(result.timedOut).toBe(true)
		expect(typeof result.stdout).toBe('string')
		expect(typeof result.stderr).toBe('string')
	})

	test('truncates oversized stdout when maxBytes is exceeded', async () => {
		const result = await spawnWithTimeout(['bun', '-e', 'console.log("x".repeat(10_000))'], {
			maxBytes: 128,
			timeoutMs: 5_000,
		})

		expect(result.timedOut).toBe(false)
		expect(result.stdoutTruncated).toBe(true)
		expect(result.stdout.length).toBeLessThanOrEqual(128)
	})
})

describe('biome tools integration', () => {
	test('syncs MCP server version with package.json', () => {
		const packageJson = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { version: string }

		expect(SERVER_VERSION).toBe(packageJson.version)
	})

	test('exposes all three tools via tools/list', async () => {
		const server = await createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const list = await client.listTools()

			const lintCheck = list.tools.find((entry) => entry.name === 'biome_lintCheck')
			expect(lintCheck).toBeDefined()
			expect(lintCheck?.title).toBe('Biome Lint Checker')
			expect(lintCheck?.annotations?.readOnlyHint).toBe(true)
			expect(lintCheck?.outputSchema).toBeDefined()

			const lintFix = list.tools.find((entry) => entry.name === 'biome_lintFix')
			expect(lintFix).toBeDefined()
			expect(lintFix?.title).toBe('Biome Lint & Format Fixer')
			expect(lintFix?.annotations?.destructiveHint).toBe(true)
			expect(lintFix?.outputSchema).toBeDefined()

			const formatCheck = list.tools.find((entry) => entry.name === 'biome_formatCheck')
			expect(formatCheck).toBeDefined()
			expect(formatCheck?.title).toBe('Biome Format Checker')
			expect(formatCheck?.annotations?.readOnlyHint).toBe(true)
			expect(formatCheck?.outputSchema).toBeDefined()
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('lintCheck returns structuredContent', async () => {
		_resetGitRootCache()
		const server = await createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'biome_lintCheck',
				arguments: {
					path: '.',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const output = result.structuredContent as {
				cwd: string
				errorCount: number
				warningCount: number
				diagnostics: Array<{ file: string; message: string }>
			}

			expect(typeof output.cwd).toBe('string')
			expect(typeof output.errorCount).toBe('number')
			expect(typeof output.warningCount).toBe('number')
			expect(Array.isArray(output.diagnostics)).toBe(true)
			expect(JSON.parse(result.content[0]?.text as string).cwd).toBe(output.cwd)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('lintCheck runs linked-worktree paths from that worktree cwd', async () => {
		_resetGitRootCache()
		const { worktree, cleanup } = await createLinkedWorktree('biome-runner-tool-linked-worktree')
		const fixtureDir = path.join(worktree, 'reports', 'biome-linked-fixture')
		await mkdir(fixtureDir, { recursive: true })
		const fixtureFile = path.join(fixtureDir, 'good.js')
		await writeFile(fixtureFile, 'export const ok = 1\n')

		const server = await createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'biome_lintCheck',
				arguments: {
					path: fixtureFile,
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			const output = result.structuredContent as {
				cwd: string
				errorCount: number
				warningCount: number
			}
			expect(output.cwd).toBe(await realpath(worktree))
			expect(output.errorCount).toBe(0)
			expect(output.warningCount).toBe(0)
			expect(JSON.parse(result.content[0]?.text as string).cwd).toBe(output.cwd)
		} finally {
			await Promise.all([client.close(), server.close()])
			await cleanup()
		}
	})

	test('tool calls and logging/setLevel are tracked as request activity', async () => {
		_resetGitRootCache()
		const activityEvents: string[] = []
		const server = await createBiomeServer({
			onRequestStart: () => {
				activityEvents.push('start')
				return () => activityEvents.push('finish')
			},
		})
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
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

			await expectToolActivity('biome_lintCheck', {
				path: '.',
				response_format: 'json',
			})
			await expectToolActivity('biome_formatCheck', {
				path: '.',
				response_format: 'json',
			})

			const fixtureParent = path.join(process.cwd(), 'reports')
			await mkdir(fixtureParent, { recursive: true })
			const fixtureDir = await mkdtemp(path.join(fixtureParent, 'biome-activity-fixture-'))
			try {
				await writeFile(path.join(fixtureDir, 'bad.js'), 'const foo={bar:1}\n')
				await expectToolActivity('biome_lintFix', {
					path: fixtureDir,
					response_format: 'json',
				})
			} finally {
				await rm(fixtureDir, { recursive: true, force: true })
			}

			activityEvents.length = 0
			await client.setLoggingLevel('info')
			expect(activityEvents).toEqual(['start', 'finish'])
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('format check returns structuredContent', async () => {
		_resetGitRootCache()
		const server = await createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'biome_formatCheck',
				arguments: {
					path: '.',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const output = result.structuredContent as {
				cwd: string
				formatted: boolean
				unformattedFiles: string[]
			}

			expect(typeof output.cwd).toBe('string')
			expect(typeof output.formatted).toBe('boolean')
			expect(Array.isArray(output.unformattedFiles)).toBe(true)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('lintFix returns structuredContent with fixed/remaining fields', async () => {
		_resetGitRootCache()
		const fixtureParent = path.join(process.cwd(), 'reports')
		await mkdir(fixtureParent, { recursive: true })
		const fixtureDir = await mkdtemp(path.join(fixtureParent, 'biome-lintfix-fixture-'))
		const fixtureFile = path.join(fixtureDir, 'bad.js')
		await writeFile(fixtureFile, 'const foo={bar:1}\n')
		const server = await createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'biome_lintFix',
				arguments: {
					path: fixtureDir,
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const output = result.structuredContent as {
				cwd: string
				fixed: number
				remaining: { errorCount: number; warningCount: number; diagnostics: unknown[] }
			}

			expect(typeof output.cwd).toBe('string')
			expect(typeof output.fixed).toBe('number')
			expect(typeof output.remaining.errorCount).toBe('number')
			expect(typeof output.remaining.warningCount).toBe('number')
			expect(Array.isArray(output.remaining.diagnostics)).toBe(true)
		} finally {
			await Promise.all([client.close(), server.close()])
			await rm(fixtureDir, { recursive: true, force: true })
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
