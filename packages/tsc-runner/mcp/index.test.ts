import { describe, expect, test } from 'bun:test'
import { rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
	_resetGitRootCache,
	createTscServer,
	formatTscMarkdown,
	parseTscOutput,
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
					message: "Type 'string' is not assignable to type 'number'.",
				},
				{ file: 'src/utils.ts', line: 20, col: 3, message: 'Argument type mismatch.' },
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
				errors: Array<{ file: string; line: number; col: number; message: string }>
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
})
