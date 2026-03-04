import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
	_resetGitRootCache,
	buildTscOutput,
	createTscInvocation,
	createTscServer,
	detectTsBuildInfoCorruption,
	formatTscMarkdown,
	parseTscOutput,
	SERVER_VERSION,
	validatePath,
	validatePathOrDefault,
} from './index'

describe('parseTscOutput', () => {
	test('parses TypeScript errors', () => {
		const output = `src/index.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/utils.ts(20,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`

		const result = parseTscOutput(output)

		expect(result.errorCount).toBe(2)
		expect(result.errors[0]?.file).toBe('src/index.ts')
		expect(result.errors[0]?.line).toBe(10)
		expect(result.errors[0]?.col).toBe(5)
		expect(result.errors[0]?.code).toBe('TS2322')
		expect(result.errors[0]?.message).toContain("Type 'string'")
		expect(result.errors[1]?.file).toBe('src/utils.ts')
		expect(result.errors[1]?.line).toBe(20)
		expect(result.errors[1]?.code).toBe('TS2345')
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

describe('formatTscMarkdown', () => {
	test('includes per-error file:line:col diagnostics', () => {
		const output = {
			cwd: '/repo',
			configPath: '/repo/tsconfig.json',
			timedOut: false,
			exitCode: 1,
			errors: [
				{
					file: 'src/index.ts',
					line: 10,
					col: 5,
					code: 'TS2322',
					message: "Type 'string' is not assignable to type 'number'.",
				},
				{
					file: 'src/utils.ts',
					line: 20,
					col: 3,
					code: 'TS2345',
					message: 'Argument type mismatch.',
				},
			],
			errorCount: 2,
		}

		const markdown = formatTscMarkdown(output)

		expect(markdown).toContain('2 type error(s)')
		expect(markdown).toContain('src/index.ts:10:5')
		expect(markdown).toContain("Type 'string' is not assignable to type 'number'.")
		expect(markdown).toContain('src/utils.ts:20:3')
		expect(markdown).toContain('Argument type mismatch.')
		expect(markdown).toContain('tsconfig.json')
	})
})

describe('createTscInvocation', () => {
	test('enables incremental mode and uses project config path', () => {
		const invocation = createTscInvocation('/repo/tsconfig.json')

		expect(invocation.cmd).toEqual([
			'bunx',
			'tsc',
			'--noEmit',
			'--pretty',
			'false',
			'--incremental',
			'--project',
			'/repo/tsconfig.json',
		])
	})

	test('applies strict env allowlist plus CI', () => {
		const previousNodePath = process.env.NODE_PATH
		const previousBunInstall = process.env.BUN_INSTALL
		const previousTmpdir = process.env.TMPDIR
		try {
			process.env.NODE_PATH = '/tmp/node-path'
			process.env.BUN_INSTALL = '/tmp/bun-install'
			process.env.TMPDIR = '/tmp'

			const invocation = createTscInvocation('/repo/tsconfig.json')
			const keys = Object.keys(invocation.env)

			expect(keys.includes('CI')).toBe(true)
			expect(keys.includes('PATH')).toBe(true)
			expect(keys.includes('HOME')).toBe(true)
			expect(keys.includes('NODE_PATH')).toBe(true)
			expect(keys.includes('BUN_INSTALL')).toBe(true)
			expect(keys.includes('TMPDIR')).toBe(true)
			expect(keys.includes('AWS_SECRET_ACCESS_KEY')).toBe(false)
			expect(keys.includes('GITHUB_TOKEN')).toBe(false)
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

describe('buildTscOutput', () => {
	test('uses parser fallback when tsc exits non-zero without parsed diagnostics', () => {
		const output = buildTscOutput({
			cwd: '/repo',
			configPath: '/repo/tsconfig.json',
			stdout: '',
			stderr: 'Internal compiler error without standard diagnostic shape',
			exitCode: 2,
			timedOut: false,
		})

		expect(output.errorCount).toBe(1)
		expect(output.errors[0]?.code).toBe('TS_PARSE_FALLBACK')
		expect(output.parseWarning).toContain('exited non-zero')
		expect(output.rawStderr).toContain('Internal compiler error')
	})

	test('adds corruption remediation hint when tsbuildinfo signatures are present', () => {
		const output = buildTscOutput({
			cwd: '/repo',
			configPath: '/repo/tsconfig.json',
			stdout: '',
			stderr:
				"Error reading /repo/.tsbuildinfo: Cannot read properties of undefined (reading 'version')",
			exitCode: 2,
			timedOut: false,
		})

		expect(output.remediationHint).toContain('Delete .tsbuildinfo and retry')
	})
})

describe('detectTsBuildInfoCorruption', () => {
	test('returns remediation hint for known corruption signatures', () => {
		const hint = detectTsBuildInfoCorruption(
			'Unexpected end of JSON input while reading cache /repo/.tsbuildinfo',
		)

		expect(hint).toContain('Delete .tsbuildinfo and retry')
	})

	test('returns null for unrelated output', () => {
		expect(detectTsBuildInfoCorruption('src/index.ts(1,1): error TS2304: MissingName')).toBeNull()
	})
})

describe('path validation', () => {
	test('rejects null bytes', async () => {
		await expect(validatePath('packages/tsc-runner\x00')).rejects.toThrow('Path contains null byte')
	})

	test('rejects control characters', async () => {
		await expect(validatePath('packages/tsc-runner\n')).rejects.toThrow(
			'Path contains control characters',
		)
	})

	test('defaults empty input to cwd', async () => {
		const resolved = await validatePathOrDefault('   ')
		expect(resolved.length).toBeGreaterThan(0)
	})

	test('rejects traversal paths outside repository', async () => {
		await expect(validatePath('../../../etc/passwd')).rejects.toThrow('Path outside repository')
	})

	test('rejects symlink escape outside repository', async () => {
		const linkPath = path.join(process.cwd(), 'tmp-tsc-outside-link')
		await rm(linkPath, { force: true })
		await symlink('/tmp', linkPath)
		try {
			await expect(validatePath(linkPath)).rejects.toThrow('Path outside repository')
		} finally {
			await rm(linkPath, { force: true })
		}
	})
})

describe('tsc_check integration', () => {
	test('syncs MCP server version with package.json', () => {
		const packageJson = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		) as { version: string }

		expect(SERVER_VERSION).toBe(packageJson.version)
	})

	test('exposes title/outputSchema/annotations via tools/list', async () => {
		const server = createTscServer()
		const client = new Client({ name: 'tsc-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const list = await client.listTools()
			const tool = list.tools.find((entry) => entry.name === 'tsc_check')

			expect(tool).toBeDefined()
			expect(tool?.title).toBe('TypeScript Type Checker')
			expect(tool?.annotations?.readOnlyHint).toBe(true)
			expect(tool?.annotations?.idempotentHint).toBe(true)
			expect(tool?.outputSchema).toBeDefined()
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('callTool returns structuredContent', async () => {
		_resetGitRootCache()
		const server = createTscServer()
		const client = new Client({ name: 'tsc-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'tsc_check',
				arguments: {
					path: '.',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const output = result.structuredContent as {
				cwd: string
				configPath: string
				timedOut: boolean
				exitCode: number
				errors: Array<{
					file: string
					line: number
					col: number
					code: string
					message: string
				}>
				errorCount: number
			}

			expect(typeof output.cwd).toBe('string')
			expect(typeof output.configPath).toBe('string')
			expect(typeof output.errorCount).toBe('number')
			expect(Array.isArray(output.errors)).toBe(true)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('returns PATH_NOT_FOUND for unknown paths', async () => {
		_resetGitRootCache()
		const server = createTscServer()
		const client = new Client({ name: 'tsc-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'tsc_check',
				arguments: {
					path: '/Users/nathanvale/code/side-quest-runners/definitely-missing-path',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(true)
			expect(result.content[0]?.type).toBe('text')
			expect(result.content[0]?.text).toContain('PATH_NOT_FOUND')
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})
})
