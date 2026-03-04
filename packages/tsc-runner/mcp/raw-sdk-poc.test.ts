import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createRawSdkTscServer } from './raw-sdk-poc'

describe('raw-sdk tsc_check PoC', () => {
	test('exposes title/outputSchema/annotations via tools/list', async () => {
		const server = createRawSdkTscServer()
		const client = new Client({ name: 'poc-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		const list = await client.listTools()
		const tool = list.tools.find((entry) => entry.name === 'tsc_check')

		expect(tool).toBeDefined()
		expect(tool?.title).toBe('TypeScript Type Checker')
		expect(tool?.annotations?.readOnlyHint).toBe(true)
		expect(tool?.annotations?.idempotentHint).toBe(true)
		expect(tool?.outputSchema).toBeDefined()

		const result = await client.callTool({
			name: 'tsc_check',
			arguments: {
				path: 'packages/tsc-runner/tsconfig.json',
				response_format: 'json',
			},
		})

		expect(result.isError).toBe(false)
		expect(result.structuredContent).toBeDefined()
		expect(typeof result.structuredContent).toBe('object')

		const structured = result.structuredContent as Record<string, unknown>
		expect(typeof structured.cwd).toBe('string')
		expect(typeof structured.configPath).toBe('string')
		expect(typeof structured.errorCount).toBe('number')
		expect(Array.isArray(structured.errors)).toBe(true)

		await Promise.all([client.close(), server.close()])
	})
})
