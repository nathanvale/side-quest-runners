#!/usr/bin/env bun

/**
 * Cross-runner smoke tests.
 *
 * Spins up each runner over stdio and executes a minimal end-to-end workflow
 * against an isolated temporary sandbox rooted inside this repository.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

interface RunnerCase {
	name: 'tsc-runner' | 'bun-runner' | 'biome-runner'
	entrypoint: string
	run(sandboxRoot: string): Promise<void>
}

interface ToolResult {
	isError?: boolean
	content?: Array<{ type: string; text?: string }>
	structuredContent?: Record<string, unknown>
}

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message)
	}
}

async function createSandboxRoot(prefix: string): Promise<string> {
	const parent = path.join(REPO_ROOT, 'reports', 'smoke-sandboxes')
	await mkdir(parent, { recursive: true })
	const root = await mkdtemp(path.join(parent, `${prefix}-`))
	return root
}

async function withRunnerClient<T>(args: {
	entrypoint: string
	cwd: string
	run: (client: Client) => Promise<T>
}): Promise<T> {
	const client = new Client({ name: 'smoke-client', version: '0.0.1' })
	const transport = new StdioClientTransport({
		command: 'bun',
		args: [args.entrypoint],
		cwd: args.cwd,
		stderr: 'pipe',
	})

	await client.connect(transport)
	try {
		return await args.run(client)
	} finally {
		await client.close()
		await transport.close()
	}
}

async function callTool(
	client: Client,
	name: string,
	parameters: Record<string, unknown>,
): Promise<ToolResult> {
	const result = await client.callTool({
		name,
		arguments: parameters,
	})
	return result as ToolResult
}

async function runTscSmoke(sandboxRoot: string): Promise<void> {
	const projectDir = path.join(sandboxRoot, 'tsc-project')
	await mkdir(projectDir, { recursive: true })
	await writeFile(
		path.join(projectDir, 'tsconfig.json'),
		JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					types: [],
				},
			},
			null,
			2,
		),
	)
	await writeFile(
		path.join(projectDir, 'index.ts'),
		"const greeting: string = 'hi';\n",
	)

	await withRunnerClient({
		entrypoint: path.join(REPO_ROOT, 'packages/tsc-runner/mcp/index.ts'),
		cwd: projectDir,
		run: async (client) => {
			const list = await client.listTools()
			const tool = list.tools.find((entry) => entry.name === 'tsc_check')
			assert(tool, 'tsc_check tool not found')
			assert(tool.outputSchema, 'tsc_check missing outputSchema')

			const passResult = await callTool(client, 'tsc_check', {
				path: '.',
				response_format: 'json',
			})
			assert(passResult.isError === false, 'tsc_check failed on passing file')
			const passOutput = passResult.structuredContent as
				| { errorCount?: number }
				| undefined
			assert(passOutput, 'tsc_check missing structuredContent')
			assert(
				passOutput.errorCount === 0,
				`tsc_check expected 0 errors, got: ${JSON.stringify(passOutput)}`,
			)

			await writeFile(
				path.join(projectDir, 'index.ts'),
				'const bad: string = 42;\n',
			)
			const failResult = await callTool(client, 'tsc_check', {
				path: '.',
				response_format: 'json',
			})
			assert(
				failResult.isError === false,
				'tsc_check should return diagnostics, not tool errors',
			)
			const failOutput = failResult.structuredContent as
				| { errorCount?: number; errors?: Array<{ code?: string }> }
				| undefined
			assert(failOutput, 'tsc_check missing structured failure output')
			assert(
				typeof failOutput.errorCount === 'number' && failOutput.errorCount > 0,
				'tsc_check expected type errors in failing case',
			)
			assert(Array.isArray(failOutput.errors), 'tsc_check missing errors array')
		},
	})
}

async function runBunSmoke(sandboxRoot: string): Promise<void> {
	const projectDir = path.join(sandboxRoot, 'bun-project')
	await mkdir(projectDir, { recursive: true })
	await writeFile(
		path.join(projectDir, 'pass.test.ts'),
		"import { expect, test } from 'bun:test';\ntest('pass', () => expect(1 + 1).toBe(2));\n",
	)
	await writeFile(
		path.join(projectDir, 'fail.test.ts'),
		"import { expect, test } from 'bun:test';\ntest('fail', () => expect(1 + 1).toBe(3));\n",
	)

	await withRunnerClient({
		entrypoint: path.join(REPO_ROOT, 'packages/bun-runner/mcp/index.ts'),
		cwd: projectDir,
		run: async (client) => {
			const list = await client.listTools()
			const runTestsTool = list.tools.find(
				(entry) => entry.name === 'bun_runTests',
			)
			const coverageTool = list.tools.find(
				(entry) => entry.name === 'bun_testCoverage',
			)
			assert(runTestsTool, 'bun_runTests tool not found')
			assert(coverageTool, 'bun_testCoverage tool not found')
			assert(runTestsTool.outputSchema, 'bun_runTests missing outputSchema')
			assert(coverageTool.outputSchema, 'bun_testCoverage missing outputSchema')

			const passResult = await callTool(client, 'bun_runTests', {
				pattern: 'pass.test.ts',
				response_format: 'json',
			})
			assert(
				passResult.isError === false,
				'bun_runTests failed on passing test',
			)
			const passOutput = passResult.structuredContent as
				| { failed?: number; total?: number }
				| undefined
			assert(passOutput, 'bun_runTests missing structuredContent')
			assert(passOutput.failed === 0, 'bun_runTests expected zero failures')
			assert(typeof passOutput.total === 'number', 'bun_runTests missing total')

			const failResult = await callTool(client, 'bun_testFile', {
				file: 'fail.test.ts',
				response_format: 'json',
			})
			assert(
				failResult.isError === false,
				'bun_testFile should return diagnostics, not tool errors',
			)
			const failOutput = failResult.structuredContent as
				| {
						failed?: number
						failures?: Array<{ file?: string; message?: string }>
				  }
				| undefined
			assert(failOutput, 'bun_testFile missing structured failure output')
			assert(
				typeof failOutput.failed === 'number' && failOutput.failed > 0,
				'bun_testFile expected at least one failed test',
			)
			assert(
				Array.isArray(failOutput.failures),
				'bun_testFile missing failures',
			)

			const coverageResult = await callTool(client, 'bun_testCoverage', {
				response_format: 'json',
			})
			assert(
				coverageResult.isError === false,
				'bun_testCoverage should succeed for smoke fixture',
			)
			const coverageOutput = coverageResult.structuredContent as
				| {
						coverage?: {
							percent?: number
							uncovered?: Array<{ file?: string; percent?: number }>
						}
				  }
				| undefined
			assert(coverageOutput, 'bun_testCoverage missing structuredContent')
			assert(
				typeof coverageOutput.coverage?.percent === 'number',
				'bun_testCoverage expected numeric coverage.percent',
			)
			assert(
				Array.isArray(coverageOutput.coverage?.uncovered),
				'bun_testCoverage expected uncovered array',
			)
		},
	})
}

async function runBiomeSmoke(sandboxRoot: string): Promise<void> {
	const projectDir = path.join(sandboxRoot, 'biome-project')
	const initialBadContents = 'const foo={bar:1}\n'
	await mkdir(projectDir, { recursive: true })
	await writeFile(path.join(projectDir, 'bad.js'), initialBadContents)

	await withRunnerClient({
		entrypoint: path.join(REPO_ROOT, 'packages/biome-runner/mcp/index.ts'),
		cwd: projectDir,
		run: async (client) => {
			const list = await client.listTools()
			const formatTool = list.tools.find(
				(entry) => entry.name === 'biome_formatCheck',
			)
			const fixTool = list.tools.find((entry) => entry.name === 'biome_lintFix')
			assert(formatTool, 'biome_formatCheck tool not found')
			assert(fixTool, 'biome_lintFix tool not found')
			assert(formatTool.outputSchema, 'biome_formatCheck missing outputSchema')
			assert(fixTool.outputSchema, 'biome_lintFix missing outputSchema')

			const before = await callTool(client, 'biome_formatCheck', {
				path: '.',
				response_format: 'json',
			})
			assert(before.isError === false, 'biome_formatCheck failed before fix')
			const beforeOutput = before.structuredContent as
				| { formatted?: boolean; unformattedFiles?: string[] }
				| undefined
			assert(beforeOutput, 'biome_formatCheck missing structuredContent')
			assert(
				beforeOutput.formatted === false,
				'expected unformatted fixture file',
			)

			const fixResult = await callTool(client, 'biome_lintFix', {
				path: '.',
				response_format: 'json',
			})
			assert(fixResult.isError === false, 'biome_lintFix failed')

			const after = await callTool(client, 'biome_formatCheck', {
				path: '.',
				response_format: 'json',
			})
			assert(after.isError === false, 'biome_formatCheck failed after fix')
			const afterOutput = after.structuredContent as
				| { formatted?: boolean; unformattedFiles?: string[] }
				| undefined
			assert(
				afterOutput,
				'biome_formatCheck missing post-fix structuredContent',
			)
			assert(
				afterOutput.formatted === true,
				'expected file to be formatted after fix',
			)

			const finalContents = await readFile(
				path.join(projectDir, 'bad.js'),
				'utf8',
			)
			assert(
				finalContents !== initialBadContents,
				'expected biome_lintFix to rewrite fixture file',
			)
		},
	})
}

async function run(): Promise<void> {
	const keepSandboxes = process.env.SMOKE_KEEP_SANDBOXES === '1'
	const sandboxRoot = await createSandboxRoot('side-quest-runners-smoke')

	const runnerCases: RunnerCase[] = [
		{
			name: 'tsc-runner',
			entrypoint: path.join(REPO_ROOT, 'packages/tsc-runner/mcp/index.ts'),
			run: runTscSmoke,
		},
		{
			name: 'bun-runner',
			entrypoint: path.join(REPO_ROOT, 'packages/bun-runner/mcp/index.ts'),
			run: runBunSmoke,
		},
		{
			name: 'biome-runner',
			entrypoint: path.join(REPO_ROOT, 'packages/biome-runner/mcp/index.ts'),
			run: runBiomeSmoke,
		},
	]

	const startedAt = Date.now()
	console.log(`Smoke sandbox root: ${sandboxRoot}`)

	try {
		for (const runnerCase of runnerCases) {
			const runnerStart = Date.now()
			console.log(`\n[smoke] ${runnerCase.name} starting...`)
			await runnerCase.run(sandboxRoot)
			const elapsedMs = Date.now() - runnerStart
			console.log(`[smoke] ${runnerCase.name} passed (${elapsedMs}ms)`)
		}
		const totalMs = Date.now() - startedAt
		console.log(`\nAll runner smoke tests passed in ${totalMs}ms.`)
	} finally {
		if (keepSandboxes) {
			console.log(`Keeping sandbox for debugging: ${sandboxRoot}`)
		} else {
			await rm(sandboxRoot, { recursive: true, force: true })
		}
	}
}

await run()
