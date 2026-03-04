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

		await Promise.all([client.close(), server.close()])
	})

	test('callTool returns structured content', async () => {
		const server = createRawSdkTscServer()
		const client = new Client({ name: 'poc-client', version: '0.0.1' })
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

		const result = await client.callTool({
			name: 'tsc_check',
			arguments: {
				path: 'packages/tsc-runner',
				response_format: 'json',
			},
		})

		// The handler always returns isError: false for type check results
		// (type errors are diagnostic data, not tool errors). However, the SDK
		// may set isError: true if outputSchema validation fails (known SDK
		// bug #1308 with z.optional()). Either way, verify we get content back.
		expect(result.content).toBeDefined()
		expect(Array.isArray(result.content)).toBe(true)
		expect(result.content.length).toBeGreaterThan(0)

		// Parse the text content to verify structured shape
		const text = (result.content[0] as { type: string; text: string }).text
		const parsed = JSON.parse(text)
		expect(typeof parsed.cwd).toBe('string')
		expect(typeof parsed.configPath).toBe('string')
		expect(typeof parsed.errorCount).toBe('number')
		expect(Array.isArray(parsed.errors)).toBe(true)

		await Promise.all([client.close(), server.close()])
	})
})
