#!/usr/bin/env bun

/**
 * Cross-runner smoke tests.
 *
 * Spins up each runner over stdio and executes a minimal end-to-end workflow
 * against an isolated temporary sandbox rooted inside this repository.
 */

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

interface RunnerCase {
	name: 'tsc-runner' | 'bun-runner' | 'biome-runner' | 'claude-hooks'
	entrypoint: string
	run(sandboxRoot: string): Promise<void>
}

interface RunnerResult {
	name: RunnerCase['name']
	passed: boolean
	elapsedMs: number
	error?: string
}

interface ToolResult {
	isError?: boolean
	content?: Array<{ type: string; text?: string }>
	structuredContent?: Record<string, unknown>
}

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')
const TOOL_TIMEOUT_MS = 15_000

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message)
	}
}

function assertObject(
	value: unknown,
	label: string,
): asserts value is Record<string, unknown> {
	assert(
		typeof value === 'object' && value !== null,
		`${label} must be an object`,
	)
}

async function createSandboxRoot(prefix: string): Promise<string> {
	// Keep smoke fixtures inside repo path boundaries required by runner validators.
	// Bun test ignores this directory via bunfig.toml testPathIgnorePatterns.
	// Do not place under gitignored or dot-directories because Biome can skip those.
	const parent = path.join(REPO_ROOT, 'smoke-sandboxes')
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

	try {
		await client.connect(transport)
		return await args.run(client)
	} finally {
		try {
			await client.close()
		} catch {
			// Ignore close failure; still close transport.
		}
		await transport.close()
	}
}

async function callTool(
	client: Client,
	name: string,
	parameters: Record<string, unknown>,
): Promise<ToolResult> {
	const resultPromise = client.callTool({
		name,
		arguments: parameters,
	})
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutHandle = setTimeout(() => {
			reject(
				new Error(`Tool call timed out after ${TOOL_TIMEOUT_MS}ms: ${name}`),
			)
		}, TOOL_TIMEOUT_MS)
	})
	try {
		const result = await Promise.race([resultPromise, timeoutPromise])
		return result as ToolResult
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle)
		}
	}
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
			const passOutput = passResult.structuredContent
			assertObject(passOutput, 'tsc_check pass structuredContent')
			assert(
				typeof passOutput.errorCount === 'number',
				'tsc_check pass output missing numeric errorCount',
			)
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
			const failOutput = failResult.structuredContent
			assertObject(failOutput, 'tsc_check fail structuredContent')
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
			const passOutput = passResult.structuredContent
			assertObject(passOutput, 'bun_runTests structuredContent')
			assert(
				typeof passOutput.failed === 'number',
				'bun_runTests missing numeric failed count',
			)
			assert(
				typeof passOutput.total === 'number',
				'bun_runTests missing numeric total count',
			)
			assert(passOutput.failed === 0, 'bun_runTests expected zero failures')
			assert(passOutput.total >= 0, 'bun_runTests missing total')

			const failResult = await callTool(client, 'bun_testFile', {
				file: 'fail.test.ts',
				response_format: 'json',
			})
			assert(
				failResult.isError === false,
				'bun_testFile should return diagnostics, not tool errors',
			)
			const failOutput = failResult.structuredContent
			assertObject(failOutput, 'bun_testFile structuredContent')
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
			const coverageOutput = coverageResult.structuredContent
			assertObject(coverageOutput, 'bun_testCoverage structuredContent')
			const coverage = coverageOutput.coverage
			assertObject(coverage, 'bun_testCoverage coverage field')
			assert(
				typeof coverage.percent === 'number',
				'bun_testCoverage expected numeric coverage.percent',
			)
			assert(
				Array.isArray(coverage.uncovered),
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
			const beforeOutput = before.structuredContent
			assertObject(beforeOutput, 'biome_formatCheck pre-fix structuredContent')
			assert(
				typeof beforeOutput.formatted === 'boolean',
				'biome_formatCheck pre-fix missing boolean formatted field',
			)
			assert(
				beforeOutput.formatted === false,
				'expected unformatted fixture file',
			)

			const fixResult = await callTool(client, 'biome_lintFix', {
				path: '.',
				response_format: 'json',
			})
			assert(fixResult.isError === false, 'biome_lintFix failed')
			const fixOutput = fixResult.structuredContent
			assertObject(fixOutput, 'biome_lintFix structuredContent')
			const remaining = fixOutput.remaining
			assertObject(remaining, 'biome_lintFix remaining field')
			assert(
				typeof fixOutput.fixed === 'number',
				'biome_lintFix missing fixed count',
			)
			assert(
				typeof remaining.errorCount === 'number',
				'biome_lintFix missing remaining.errorCount',
			)

			const after = await callTool(client, 'biome_formatCheck', {
				path: '.',
				response_format: 'json',
			})
			assert(after.isError === false, 'biome_formatCheck failed after fix')
			const afterOutput = after.structuredContent
			assertObject(afterOutput, 'biome_formatCheck post-fix structuredContent')
			assert(
				afterOutput.formatted === true,
				'biome_lintFix did not produce a formatted workspace',
			)
			assert(
				Array.isArray(afterOutput.unformattedFiles) &&
					afterOutput.unformattedFiles.length === 0,
				'biome_formatCheck still reports unformatted files after biome_lintFix',
			)
		},
	})
}

async function runClaudeHooksSmoke(sandboxRoot: string): Promise<void> {
	const cacheRoot = path.join(sandboxRoot, 'hooks-cache')
	await mkdir(cacheRoot, { recursive: true })
	const hookInput = {
		hook_event_name: 'PostToolUse',
		cwd: process.cwd(),
		tool_name: 'mcp__tsc-runner__tsc_check',
		tool_use_id: 'toolu_smoke_123',
		tool_input: { path: '.' },
		tool_response: {
			errorCount: 0,
			errors: [],
		},
	}

	const escapedPayload = JSON.stringify(hookInput).replaceAll("'", "'\"'\"'")
	const command = [
		`printf '%s\\n' '${escapedPayload}'`,
		`bun ${path.join(REPO_ROOT, 'packages/claude-hooks/hooks/index.ts')} posttool`,
	].join(' | ')

	const proc = Bun.spawn(['bash', '-lc', command], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			...process.env,
			SQ_HOOK_DEDUP_ENABLED: '1',
			TMPDIR: cacheRoot,
		},
	})

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	])

	assert(exitCode === 0, `claude-hooks exited with ${exitCode}: ${stderr}`)
	const parsed = JSON.parse(stdout)
	assertObject(parsed, 'claude-hooks stdout payload')
	const hookSpecificOutput = parsed.hookSpecificOutput
	assertObject(hookSpecificOutput, 'claude-hooks hookSpecificOutput')
	assert(
		hookSpecificOutput.hookEventName === 'PostToolUse',
		'claude-hooks expected PostToolUse hookEventName',
	)
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
		{
			name: 'claude-hooks',
			entrypoint: path.join(REPO_ROOT, 'packages/claude-hooks/hooks/index.ts'),
			run: runClaudeHooksSmoke,
		},
	]

	const startedAt = Date.now()
	const results: RunnerResult[] = []
	console.log(`Smoke sandbox root: ${sandboxRoot}`)

	try {
		for (const runnerCase of runnerCases) {
			const runnerStart = Date.now()
			console.log(`\n[smoke] ${runnerCase.name} starting...`)
			try {
				await runnerCase.run(sandboxRoot)
				const elapsedMs = Date.now() - runnerStart
				results.push({
					name: runnerCase.name,
					passed: true,
					elapsedMs,
				})
				console.log(`[smoke] ${runnerCase.name} passed (${elapsedMs}ms)`)
			} catch (error) {
				const elapsedMs = Date.now() - runnerStart
				const message = error instanceof Error ? error.message : String(error)
				results.push({
					name: runnerCase.name,
					passed: false,
					elapsedMs,
					error: message,
				})
				console.error(
					`[smoke] ${runnerCase.name} failed (${elapsedMs}ms): ${message}`,
				)
				const runnerError = new Error(`[${runnerCase.name}] ${message}`, {
					cause: error,
				})
				throw runnerError
			}
		}
		const totalMs = Date.now() - startedAt
		console.log(`\nAll runner smoke tests passed in ${totalMs}ms.`)
	} finally {
		const summaryPath = process.env.GITHUB_STEP_SUMMARY
		if (summaryPath) {
			const rows = results.map((result) => {
				const status = result.passed ? 'pass' : 'FAIL'
				const errorSuffix = result.error ? ` (${result.error})` : ''
				return `| ${result.name} | ${status}${errorSuffix} | ${result.elapsedMs}ms |`
			})
			const summary = [
				'## Smoke Tests (MCP stdio)',
				'',
				'| Runner | Status | Time |',
				'|---|---|---|',
				...rows,
				'',
			].join('\n')
			try {
				await appendFile(summaryPath, summary)
			} catch (error) {
				console.error(
					`Failed to append smoke summary: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		if (keepSandboxes) {
			console.log(`Keeping sandbox for debugging: ${sandboxRoot}`)
		} else {
			try {
				await rm(sandboxRoot, { recursive: true, force: true })
			} catch (error) {
				console.error(
					`Failed to cleanup smoke sandbox (${sandboxRoot}): ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}
}

await run()
