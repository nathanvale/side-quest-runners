import { describe, expect, test } from 'bun:test'
import { rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
	_resetGitRootCache,
	createBiomeServer,
	parseBiomeOutput,
	validatePath,
	validatePathOrDefault,
} from './index'

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
		await expect(validatePath('../../../etc/passwd')).rejects.toThrow('Path outside repository')
	})

	test('rejects symlink escape outside repository', async () => {
		const linkPath = path.join(process.cwd(), 'tmp-biome-outside-link')
		await rm(linkPath, { force: true })
		await symlink('/tmp', linkPath)
		try {
			await expect(validatePath(linkPath)).rejects.toThrow('Path outside repository')
		} finally {
			await rm(linkPath, { force: true })
		}
	})
})

describe('biome tools integration', () => {
	test('exposes all three tools via tools/list', async () => {
		const server = createBiomeServer()
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
			expect(lintFix?.title).toBe('Biome Lint Fixer')
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
		const server = createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'biome_lintCheck',
				arguments: {
					path: 'packages/biome-runner',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const output = result.structuredContent as {
				errorCount: number
				warningCount: number
				diagnostics: Array<{ file: string; message: string }>
			}

			expect(typeof output.errorCount).toBe('number')
			expect(typeof output.warningCount).toBe('number')
			expect(Array.isArray(output.diagnostics)).toBe(true)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})

	test('format check returns structuredContent', async () => {
		_resetGitRootCache()
		const server = createBiomeServer()
		const client = new Client({ name: 'biome-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		try {
			const result = await client.callTool({
				name: 'biome_formatCheck',
				arguments: {
					path: 'packages/biome-runner',
					response_format: 'json',
				},
			})

			expect(result.isError).toBe(false)
			expect(result.structuredContent).toBeDefined()

			const output = result.structuredContent as {
				formatted: boolean
				unformattedFiles: string[]
			}

			expect(typeof output.formatted).toBe('boolean')
			expect(Array.isArray(output.unformattedFiles)).toBe(true)
		} finally {
			await Promise.all([client.close(), server.close()])
		}
	})
})
