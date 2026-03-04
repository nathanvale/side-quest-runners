#!/usr/bin/env bun

/// <reference types="bun-types" />

/**
 * Bun Test Runner MCP Server
 *
 * Provides tools to run Bun tests with structured, token-efficient output.
 */

import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
	parseBunTestOutput,
	type TestFailure,
	type TestSummary,
} from './parse-utils'

/**
 * Bridge Zod-inferred output types to the SDK's Record<string, unknown>.
 *
 * Why: CallToolResult.structuredContent is typed as Record<string, unknown>,
 * but our Zod-inferred types have concrete keys that TypeScript considers
 * structurally incompatible. This helper centralizes the unavoidable cast.
 */
function toStructured(value: object): Record<string, unknown> {
	return value as Record<string, unknown>
}

const TEST_TIMEOUT_MS = 30_000
const COVERAGE_TIMEOUT_MS = 60_000

const failureSchema = z.object({
	file: z.string(),
	message: z.string(),
	line: z.number().nullable(),
	stack: z.string().nullable(),
})

const testSummarySchema = z.object({
	passed: z.number(),
	failed: z.number(),
	total: z.number(),
	failures: z.array(failureSchema),
})

const testCoverageSchema = z.object({
	summary: testSummarySchema,
	coverage: z.object({
		percent: z.number(),
		uncovered: z.array(z.string()),
	}),
})

let _gitRootPromise: Promise<string> | null = null

/**
 * Get the git root once per process using promise coalescing.
 *
 * Why: every path validation needs repo boundaries, so one shared promise avoids
 * duplicate subprocesses during concurrent tool calls.
 */
export function getGitRoot(): Promise<string> {
	if (_gitRootPromise !== null) {
		return _gitRootPromise
	}
	_gitRootPromise = resolveGitRoot()
	return _gitRootPromise
}

async function resolveGitRoot(): Promise<string> {
	const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], {
		stdout: 'pipe',
		stderr: 'pipe',
	})

	const [stdout, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		proc.exited,
	])

	if (exitCode !== 0) {
		throw new Error('Not inside a git repository')
	}

	return realpath(stdout.trim())
}

/**
 * Reset git-root cache for tests.
 */
export function _resetGitRootCache(): void {
	_gitRootPromise = null
}

/**
 * Validate and canonicalize a path while enforcing repository boundaries.
 *
 * Why: test file/path inputs are user-controlled and must not escape the repo.
 */
export async function validatePath(inputPath: string): Promise<string> {
	if (inputPath.includes('\x00')) {
		throw new Error('Path contains null byte')
	}
	if (hasControlCharacters(inputPath)) {
		throw new Error(
			`Path contains control characters: ${JSON.stringify(inputPath)}`,
		)
	}
	if (!inputPath || inputPath.trim() === '') {
		throw new Error('Path cannot be empty')
	}

	const resolvedPath = path.resolve(inputPath)
	let realInputPath: string

	try {
		realInputPath = await realpath(resolvedPath)
	} catch (error) {
		const err = error as NodeJS.ErrnoException
		if (err.code === 'ENOENT') {
			realInputPath = await resolveNearestAncestor(resolvedPath)
		} else {
			throw new Error(`Cannot resolve path: ${err.message}`)
		}
	}

	const gitRoot = await getGitRoot()
	if (realInputPath !== gitRoot && !realInputPath.startsWith(`${gitRoot}/`)) {
		throw new Error(`Path outside repository: ${inputPath}`)
	}

	return realInputPath
}

/**
 * Resolve a non-existent path by walking up to the nearest existing ancestor
 * and applying realpath there, then re-appending the remaining segments.
 *
 * Why: a naive fallback to path.resolve on ENOENT misses intermediate symlinks
 * that could escape the repository boundary.
 */
async function resolveNearestAncestor(resolvedPath: string): Promise<string> {
	let dir = path.dirname(resolvedPath)
	const suffix = path.basename(resolvedPath)
	const segments: string[] = [suffix]

	while (dir !== path.dirname(dir)) {
		try {
			const realDir = await realpath(dir)
			return path.join(realDir, ...segments)
		} catch {
			segments.unshift(path.basename(dir))
			dir = path.dirname(dir)
		}
	}

	return resolvedPath
}

/**
 * Validate shell pattern safety before passing it to bun test.
 *
 * Why: pattern arguments are command-adjacent input and need defense-in-depth
 * against flag injection and shell meta-character abuse.
 */
export function validateShellSafePattern(pattern: string): void {
	if (!pattern || pattern.trim() === '') {
		throw new Error('Pattern cannot be empty')
	}
	if (hasShellUnsafeCharacters(pattern)) {
		throw new Error(
			`Pattern contains unsafe characters: ${JSON.stringify(pattern)}`,
		)
	}
	if (pattern.startsWith('-')) {
		throw new Error(
			'Pattern must not start with a dash (prevents flag injection)',
		)
	}
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) {
			return true
		}
	}
	return false
}

function hasShellUnsafeCharacters(value: string): boolean {
	const unsafe = new Set([';', '&', '|', '<', '>', '`', '$', '\\'])
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index]
		if (!char) {
			continue
		}
		if (unsafe.has(char)) {
			return true
		}
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) {
			return true
		}
	}
	return false
}

function normalizeSummary(
	summary: TestSummary,
): z.infer<typeof testSummarySchema> {
	return {
		passed: summary.passed,
		failed: summary.failed,
		total: summary.total,
		failures: summary.failures.map((failure: TestFailure) => ({
			file: failure.file,
			message: failure.message,
			line: failure.line ?? null,
			stack: failure.stack ?? null,
		})),
	}
}

async function spawnWithTimeout(
	cmd: string[],
	timeoutMs: number,
	options?: {
		env?: Record<string, string>
	},
): Promise<{
	stdout: string
	stderr: string
	exitCode: number
	timedOut: boolean
}> {
	const proc = Bun.spawn(cmd, {
		env: options?.env,
		stdout: 'pipe',
		stderr: 'pipe',
	})

	let timedOut = false
	let killTimer: ReturnType<typeof setTimeout> | undefined
	const timeout = setTimeout(() => {
		timedOut = true
		proc.kill('SIGTERM')
		killTimer = setTimeout(() => {
			try {
				proc.kill('SIGKILL')
			} catch {}
		}, 5_000)
	}, timeoutMs)

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])

	clearTimeout(timeout)
	if (killTimer) clearTimeout(killTimer)
	return { stdout, stderr, exitCode, timedOut }
}

/**
 * Run Bun tests and return structured summary.
 *
 * Why: test failures are diagnostic results, not tool failures, so callers need
 * structured failure data even when tests fail.
 */
async function runBunTests(
	pattern?: string,
): Promise<z.infer<typeof testSummarySchema>> {
	const cmd = pattern ? ['bun', 'test', '--', pattern] : ['bun', 'test']

	const { stdout, stderr, exitCode, timedOut } = await spawnWithTimeout(
		cmd,
		TEST_TIMEOUT_MS,
		{ env: { ...process.env, CI: 'true' } },
	)

	if (timedOut) {
		return {
			passed: 0,
			failed: 1,
			total: 1,
			failures: [
				{
					file: 'timeout',
					line: null,
					stack: null,
					message:
						'Tests timed out after 30 seconds. Possible causes: open handles, infinite loops, or accidental watch mode.',
				},
			],
		}
	}

	const output = `${stdout}\n${stderr}`
	if (exitCode === 0) {
		const passMatch = output.match(/(\d+) pass/)
		const passed = passMatch?.[1] ? Number.parseInt(passMatch[1], 10) : 0
		return {
			passed,
			failed: 0,
			total: passed,
			failures: [],
		}
	}

	return normalizeSummary(parseBunTestOutput(output))
}

async function runBunTestCoverage(): Promise<
	z.infer<typeof testCoverageSchema>
> {
	const { stdout, stderr, timedOut } = await spawnWithTimeout(
		['bun', 'test', '--coverage'],
		COVERAGE_TIMEOUT_MS,
		{ env: { ...process.env, CI: 'true' } },
	)

	const output = `${stdout}\n${stderr}`
	if (timedOut) {
		return {
			summary: {
				passed: 0,
				failed: 1,
				total: 1,
				failures: [
					{
						file: 'timeout',
						line: null,
						stack: null,
						message: 'Tests timed out after 60 seconds.',
					},
				],
			},
			coverage: { percent: 0, uncovered: [] },
		}
	}

	const summary = normalizeSummary(parseBunTestOutput(output))
	const coverageMatch = output.match(/(\d+(?:\.\d+)?)\s*%/)
	const percent = coverageMatch?.[1] ? Number.parseFloat(coverageMatch[1]) : 0

	const uncovered: string[] = []
	for (const line of output.split('\n')) {
		const match = line.match(/^([^\s|]+)\s*\|\s*(\d+(?:\.\d+)?)\s*%/)
		if (!match?.[1] || !match[2]) {
			continue
		}
		const file = match[1].trim()
		const fileCoverage = Number.parseFloat(match[2])
		if (fileCoverage < 50 && file.endsWith('.ts')) {
			uncovered.push(`${file} (${fileCoverage}%)`)
		}
	}

	return {
		summary,
		coverage: { percent, uncovered },
	}
}

function formatTestSummary(
	summary: z.infer<typeof testSummarySchema>,
	format: 'markdown' | 'json',
	context?: string,
): string {
	if (format === 'json') {
		return JSON.stringify({ ...summary, context })
	}

	if (summary.failed === 0) {
		return context
			? `All ${summary.passed} tests passed in ${context}.`
			: `All ${summary.passed} tests passed.`
	}

	let output = `${summary.failed} tests failed${context ? ` in ${context}` : ''} (${summary.passed} passed)\n\n`
	for (let index = 0; index < summary.failures.length; index += 1) {
		const failure = summary.failures[index]
		if (!failure) {
			continue
		}
		output += `${index + 1}. ${failure.file}:${failure.line ?? '?'}\n`
		output += `   ${failure.message.split('\n')[0]}\n`
		if (failure.stack) {
			output += `${failure.stack
				.split('\n')
				.map((line) => `      ${line}`)
				.join('\n')}\n`
		}
		output += '\n'
	}

	return output.trim()
}

function formatCoverageResult(
	result: z.infer<typeof testCoverageSchema>,
	format: 'markdown' | 'json',
): string {
	if (format === 'json') {
		return JSON.stringify(result)
	}

	let output =
		result.summary.failed === 0
			? `All ${result.summary.passed} tests passed.\n\n`
			: `${result.summary.failed} tests failed (${result.summary.passed} passed)\n\n`

	output += `Coverage: ${result.coverage.percent}%\n`

	if (result.coverage.uncovered.length > 0) {
		output += '\nFiles with low coverage (<50%):\n'
		for (const file of result.coverage.uncovered) {
			output += `   - ${file}\n`
		}
	}

	return output.trim()
}

/**
 * Create the bun-runner MCP server.
 *
 * Why: factory construction isolates registration logic for in-memory
 * integration tests and keeps stdio lifecycle wiring separate.
 */
export function createBunServer(): McpServer {
	const server = new McpServer({
		name: 'bun-runner',
		version: '1.0.3',
	})

	server.registerTool(
		'bun_runTests',
		{
			title: 'Bun Test Runner',
			description:
				'Run Bun tests for suite-level regression checks. Returns pass/fail counts and structured failures. Read-only. No fixes or coverage. Use bun_testFile for one file; bun_testCoverage for coverage.',
			inputSchema: z.object({
				pattern: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"File pattern or test name to filter tests (e.g., 'auth' or 'login.test.ts')",
					),
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: testSummarySchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args): Promise<CallToolResult> => {
			try {
				const pattern = args.pattern
				if (pattern) {
					validateShellSafePattern(pattern)
					if (pattern.includes('/') || pattern.includes('..')) {
						await validatePath(pattern)
					}
				}

				const summary = await runBunTests(pattern)
				const format = args.response_format ?? 'json'
				return {
					isError: false,
					content: [{ type: 'text', text: formatTestSummary(summary, format) }],
					structuredContent: toStructured(summary),
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					isError: true,
					content: [{ type: 'text', text: `Error: ${message}` }],
				}
			}
		},
	)

	server.registerTool(
		'bun_testFile',
		{
			title: 'Bun Single File Test Runner',
			description:
				'Run Bun tests for one exact test file path with structured failures. Use during focused debugging. Read-only. Not full-suite or coverage. Use bun_runTests for suite checks; bun_testCoverage for coverage.',
			inputSchema: z.object({
				file: z
					.string()
					.max(4096)
					.describe("Path to the test file to run (e.g., 'src/utils.test.ts')"),
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: testSummarySchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args): Promise<CallToolResult> => {
			try {
				const validatedFile = await validatePath(args.file)
				const summary = await runBunTests(validatedFile)
				const format = args.response_format ?? 'json'
				return {
					isError: false,
					content: [
						{
							type: 'text',
							text: formatTestSummary(summary, format, args.file),
						},
					],
					structuredContent: toStructured(summary),
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					isError: true,
					content: [{ type: 'text', text: `Error: ${message}` }],
				}
			}
		},
	)

	server.registerTool(
		'bun_testCoverage',
		{
			title: 'Bun Test Coverage Reporter',
			description:
				'Run Bun tests with coverage. Returns test summary, coverage percent, and low-coverage files. Read-only and slower than bun_runTests. No fixes. Use bun_runTests for faster no-coverage checks.',
			inputSchema: z.object({
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: testCoverageSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args): Promise<CallToolResult> => {
			try {
				const result = await runBunTestCoverage()
				const format = args.response_format ?? 'json'
				return {
					isError: false,
					content: [
						{ type: 'text', text: formatCoverageResult(result, format) },
					],
					structuredContent: toStructured(result),
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return {
					isError: true,
					content: [{ type: 'text', text: `Error: ${message}` }],
				}
			}
		},
	)

	return server
}

/**
 * Start the stdio MCP server process.
 */
export async function startBunServer(): Promise<void> {
	const server = createBunServer()
	const transport = new StdioServerTransport()
	let shuttingDown = false

	const shutdown = async () => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		await server.close()
		process.exit(0)
	}

	transport.onclose = () => {
		void shutdown()
	}

	await server.connect(transport)
	process.stdin.resume()

	process.on('SIGINT', () => {
		void shutdown()
	})
	process.on('SIGTERM', () => {
		void shutdown()
	})
}

/**
 * Re-export types and parsing function from parse-utils for hook reuse.
 */
export type { TestFailure, TestSummary }
export { parseBunTestOutput }

if (import.meta.main) {
	void startBunServer()
}
