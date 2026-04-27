#!/usr/bin/env bun

/// <reference types="bun-types" />

/**
 * Bun Test Runner MCP Server
 *
 * Provides tools to run Bun tests with structured, token-efficient output.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import {
	configure,
	dispose,
	fingersCrossed,
	getLogger,
	getStreamSink,
	jsonLinesFormatter,
	type LogLevel,
	type LogRecord,
	type Sink,
	withContext,
} from '@logtape/logtape'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
	CallToolResult,
	LoggingLevel,
} from '@modelcontextprotocol/sdk/types.js'
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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
const BUN_OUTPUT_CAPTURE_MAX_BYTES = 16 * 1024 * 1024
const configuredCoverageLowThreshold = Number.parseFloat(
	process.env.BUN_COVERAGE_LOW_THRESHOLD ?? '50',
)
const COVERAGE_LOW_THRESHOLD = Number.isFinite(configuredCoverageLowThreshold)
	? configuredCoverageLowThreshold
	: 50
const BUN_ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'NODE_PATH',
	'BUN_INSTALL',
	'TMPDIR',
] as const
const TOOL_ERROR_CODES = [
	'TIMEOUT',
	'SPAWN_FAILURE',
	'PATTERN_INVALID',
] as const

type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number]
const DEFAULT_MCP_LOG_LEVEL: LoggingLevel = 'warning'

const MCP_LOG_LEVEL_SEVERITY: Record<LoggingLevel, number> = {
	debug: 7,
	info: 6,
	notice: 5,
	warning: 4,
	error: 3,
	critical: 2,
	alert: 1,
	emergency: 0,
}

const LOGTAPE_TO_MCP_LEVEL: Record<LogLevel, LoggingLevel> = {
	trace: 'debug',
	debug: 'debug',
	info: 'info',
	warning: 'warning',
	error: 'error',
	fatal: 'critical',
}

interface ToolFailure {
	code: ToolErrorCode
	message: string
}

class BunToolError extends Error {
	code: ToolErrorCode

	constructor(code: ToolErrorCode, message: string) {
		super(message)
		this.code = code
	}
}

interface ObservabilityState {
	clientMcpLogLevel: LoggingLevel
}

interface BunServerOptions {
	stderrStream?: WritableStream
}

async function collectStreamText(
	stream: ReadableStream<Uint8Array> | number | null | undefined,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	if (
		stream === null ||
		stream === undefined ||
		typeof stream === 'number' ||
		typeof (stream as ReadableStream<Uint8Array>).getReader !== 'function'
	) {
		return { text: '', truncated: false }
	}

	const reader = stream.getReader()
	const decoder = new TextDecoder()
	let text = ''
	let capturedBytes = 0
	let truncated = false

	while (true) {
		const { done, value } = await reader.read()
		if (done) break
		if (!value) continue

		if (truncated) {
			continue
		}

		const remaining = maxBytes - capturedBytes
		if (remaining <= 0) {
			truncated = true
			continue
		}

		if (value.byteLength <= remaining) {
			text += decoder.decode(value, { stream: true })
			capturedBytes += value.byteLength
			continue
		}

		text += decoder.decode(value.subarray(0, remaining), { stream: true })
		capturedBytes += remaining
		truncated = true
	}

	text += decoder.decode()
	return { text, truncated }
}

const failureSchema: z.ZodObject<{
	file: z.ZodString
	message: z.ZodString
	line: z.ZodNullable<z.ZodOptional<z.ZodNumber>>
	stack: z.ZodNullable<z.ZodOptional<z.ZodString>>
}> = z.object({
	file: z.string(),
	message: z.string(),
	line: z.number().optional().nullable(),
	stack: z.string().optional().nullable(),
})

const testSummarySchema: z.ZodObject<{
	passed: z.ZodNumber
	failed: z.ZodNumber
	total: z.ZodNumber
	failures: z.ZodArray<typeof failureSchema>
}> = z.object({
	passed: z.number(),
	failed: z.number(),
	total: z.number(),
	failures: z.array(failureSchema),
})

const coverageFileSchema: z.ZodObject<{
	file: z.ZodString
	percent: z.ZodNumber
}> = z.object({
	file: z.string(),
	percent: z.number(),
})

const testCoverageSchema: z.ZodObject<{
	summary: typeof testSummarySchema
	coverage: z.ZodObject<{
		percent: z.ZodNumber
		uncovered: z.ZodArray<typeof coverageFileSchema>
	}>
}> = z.object({
	summary: testSummarySchema,
	coverage: z.object({
		percent: z.number(),
		uncovered: z.array(coverageFileSchema),
	}),
})

/**
 * Resolve package version from package.json at module load.
 *
 * Why: keeps MCP server metadata aligned with published package version
 * without requiring manual code updates each release.
 */
const PACKAGE_VERSION: string = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version
export const SERVER_VERSION: string = PACKAGE_VERSION

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
		throw new BunToolError('PATTERN_INVALID', 'Pattern cannot be empty')
	}
	if (hasShellUnsafeCharacters(pattern)) {
		throw new BunToolError(
			'PATTERN_INVALID',
			`Pattern contains unsafe characters: ${JSON.stringify(pattern)}`,
		)
	}
	if (pattern.startsWith('-')) {
		throw new BunToolError(
			'PATTERN_INVALID',
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

function stripNullishDeep<T>(value: T): T {
	if (value === null || value === undefined) {
		return value
	}
	if (Array.isArray(value)) {
		return value.map((entry) => stripNullishDeep(entry)) as T
	}
	if (typeof value !== 'object') {
		return value
	}
	const source = value as Record<string, unknown>
	const result: Record<string, unknown> = {}
	for (const [key, entry] of Object.entries(source)) {
		if (entry === null || entry === undefined) {
			continue
		}
		result[key] = stripNullishDeep(entry)
	}
	return result as T
}

/**
 * Build Bun invocation command and sanitized environment.
 *
 * Why: spawn reliability and env-leak prevention should be testable as a pure
 * function without running subprocesses.
 */
export function createBunInvocation(pattern?: string): {
	cmd: string[]
	env: Record<string, string>
} {
	const env: Record<string, string> = { CI: 'true' }
	for (const key of BUN_ENV_ALLOWLIST) {
		const value = process.env[key]
		if (typeof value === 'string' && value.length > 0) {
			env[key] = value
		}
	}

	return {
		cmd: pattern ? ['bun', 'test', '--', pattern] : ['bun', 'test'],
		env,
	}
}

/**
 * Build Bun coverage invocation command and sanitized environment.
 *
 * Why: coverage mode is a Bun flag and must not be passed as a positional test
 * pattern, or coverage reporting silently degrades.
 */
export function createBunCoverageInvocation(): {
	cmd: string[]
	env: Record<string, string>
} {
	const env: Record<string, string> = { CI: 'true' }
	for (const key of BUN_ENV_ALLOWLIST) {
		const value = process.env[key]
		if (typeof value === 'string' && value.length > 0) {
			env[key] = value
		}
	}

	return {
		cmd: ['bun', 'test', '--coverage'],
		env,
	}
}

function createBunStderrWritableStream(): WritableStream {
	let writer: ReturnType<(typeof Bun.stderr)['writer']> | null = null

	return new WritableStream({
		start() {
			writer = Bun.stderr.writer()
		},
		write(chunk: Uint8Array | string) {
			if (!writer) {
				return
			}
			if (typeof chunk === 'string') {
				writer.write(new TextEncoder().encode(chunk))
				return
			}
			writer.write(chunk)
		},
		async close() {
			if (writer) {
				try {
					await writer.flush()
				} catch {}
			}
			writer = null
		},
		async abort() {
			if (writer) {
				try {
					await writer.flush()
				} catch {}
			}
			writer = null
		},
	})
}

function shouldForwardMcpLog(
	recordLevel: LogLevel,
	clientLevel: LoggingLevel,
): boolean {
	const mcpLevel = LOGTAPE_TO_MCP_LEVEL[recordLevel]
	return MCP_LOG_LEVEL_SEVERITY[mcpLevel] <= MCP_LOG_LEVEL_SEVERITY[clientLevel]
}

function stringifyLogMessage(parts: readonly unknown[]): string {
	return parts.map((part) => String(part)).join('')
}

function createMcpProtocolSink(
	server: McpServer,
	state: ObservabilityState,
): Sink {
	return (record: LogRecord): void => {
		if (!server.isConnected()) {
			return
		}
		if (!shouldForwardMcpLog(record.level, state.clientMcpLogLevel)) {
			return
		}

		try {
			const result = server.sendLoggingMessage({
				level: LOGTAPE_TO_MCP_LEVEL[record.level],
				logger: record.category.join('.'),
				data: {
					message: stringifyLogMessage(record.message),
					properties: record.properties,
				},
			})
			void Promise.resolve(result).catch(() => undefined)
		} catch {
			// best-effort sink: drop notification when transport is no longer writable
		}
	}
}

async function setupObservability(
	server: McpServer,
	state: ObservabilityState,
	options?: BunServerOptions,
): Promise<void> {
	const stderrSink = getStreamSink(
		options?.stderrStream ?? createBunStderrWritableStream(),
		{
			formatter: jsonLinesFormatter,
		},
	)

	const bufferedStderrSink = fingersCrossed(stderrSink, {
		triggerLevel: 'warning',
		maxBufferSize: 200,
		isolateByCategory: 'descendant',
		isolateByContext: {
			keys: ['requestId'],
			maxContexts: 50,
			bufferTtlMs: 60_000,
			cleanupIntervalMs: 30_000,
		},
	})

	const mcpProtocolSink = createMcpProtocolSink(server, state)

	await configure({
		reset: true,
		contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
		sinks: {
			stderrBuffered: bufferedStderrSink,
			mcpProtocol: mcpProtocolSink,
		},
		loggers: [
			{
				category: ['mcp'],
				sinks: ['stderrBuffered', 'mcpProtocol'],
				lowestLevel: 'debug',
			},
			{
				category: ['logtape'],
				sinks: ['stderrBuffered'],
				lowestLevel: 'error',
			},
		],
	})
}

function toToolFailure(error: unknown): ToolFailure {
	if (error instanceof BunToolError) {
		return { code: error.code, message: error.message }
	}

	const message = error instanceof Error ? error.message : String(error)
	return {
		code: 'SPAWN_FAILURE',
		message,
	}
}

function createToolSuccess(text: string, structured: object): CallToolResult {
	return {
		isError: false,
		content: [{ type: 'text', text }],
		structuredContent: toStructured(stripNullishDeep(structured)),
	}
}

function createToolFailure(failure: ToolFailure): CallToolResult {
	return {
		isError: true,
		content: [{ type: 'text', text: `${failure.code}: ${failure.message}` }],
		structuredContent: toStructured(failure),
	}
}

/**
 * Spawn a subprocess and enforce timeout with SIGTERM -> SIGKILL escalation.
 *
 * Why: bun-runner tools must avoid hanging CI and local checks on stalled subprocesses.
 */
export async function spawnWithTimeout(
	cmd: string[],
	timeoutMs: number,
	options?: {
		env?: Record<string, string>
		maxBytes?: number
	},
): Promise<{
	stdout: string
	stderr: string
	exitCode: number
	timedOut: boolean
	stdoutTruncated: boolean
	stderrTruncated: boolean
}> {
	const proc = (() => {
		try {
			return Bun.spawn(cmd, {
				env: options?.env,
				stdout: 'pipe',
				stderr: 'pipe',
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new BunToolError(
				'SPAWN_FAILURE',
				`Failed to start bun test: ${message}`,
			)
		}
	})()

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

	const maxBytes = options?.maxBytes ?? BUN_OUTPUT_CAPTURE_MAX_BYTES
	const [stdoutResult, stderrResult, exitCode] = await Promise.all([
		collectStreamText(proc.stdout, maxBytes),
		collectStreamText(proc.stderr, maxBytes),
		proc.exited,
	])

	clearTimeout(timeout)
	if (killTimer) clearTimeout(killTimer)
	return {
		stdout: stdoutResult.text,
		stderr: stderrResult.text,
		exitCode,
		timedOut,
		stdoutTruncated: stdoutResult.truncated,
		stderrTruncated: stderrResult.truncated,
	}
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
	const invocation = createBunInvocation(pattern)

	const {
		stdout,
		stderr,
		exitCode,
		timedOut,
		stdoutTruncated,
		stderrTruncated,
	} = await spawnWithTimeout(invocation.cmd, TEST_TIMEOUT_MS, {
		env: invocation.env,
	})

	if (timedOut) {
		throw new BunToolError(
			'TIMEOUT',
			`Tests timed out after ${TEST_TIMEOUT_MS / 1000} seconds. Possible causes: open handles, infinite loops, or accidental watch mode.`,
		)
	}
	if (stdoutTruncated || stderrTruncated) {
		throw new BunToolError(
			'SPAWN_FAILURE',
			`bun test output exceeded ${BUN_OUTPUT_CAPTURE_MAX_BYTES} bytes. Narrow test scope or run without heavy verbose output.`,
		)
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

	const lowerStderr = stderr.toLowerCase()
	if (
		lowerStderr.includes('command not found') ||
		lowerStderr.includes('not recognized') ||
		lowerStderr.includes('enoent')
	) {
		throw new BunToolError(
			'SPAWN_FAILURE',
			`Failed to run bun test: ${stderr.trim() || 'missing stderr output'}`,
		)
	}

	return normalizeSummary(parseBunTestOutput(output))
}

async function runBunTestCoverage(): Promise<
	z.infer<typeof testCoverageSchema>
> {
	const invocation = createBunCoverageInvocation()
	const {
		stdout,
		stderr,
		exitCode,
		timedOut,
		stdoutTruncated,
		stderrTruncated,
	} = await spawnWithTimeout(invocation.cmd, COVERAGE_TIMEOUT_MS, {
		env: invocation.env,
	})

	if (timedOut) {
		throw new BunToolError(
			'TIMEOUT',
			`Coverage tests timed out after ${COVERAGE_TIMEOUT_MS / 1000} seconds.`,
		)
	}
	if (stdoutTruncated || stderrTruncated) {
		throw new BunToolError(
			'SPAWN_FAILURE',
			`bun test --coverage output exceeded ${BUN_OUTPUT_CAPTURE_MAX_BYTES} bytes. Narrow test scope or disable excessive logging.`,
		)
	}

	const output = `${stdout}\n${stderr}`
	const parsed = parseBunTestOutput(output)
	if (exitCode !== 0 && parsed.total === 0 && parsed.failed === 0) {
		throw new BunToolError(
			'SPAWN_FAILURE',
			`bun test --coverage failed: ${stderr.trim() || stdout.trim() || 'missing output'}`,
		)
	}
	const summary = normalizeSummary(parsed)
	const coverageMatch = output.match(/(\d+(?:\.\d+)?)\s*%/)
	const percent = coverageMatch?.[1] ? Number.parseFloat(coverageMatch[1]) : 0

	const uncovered: Array<{ file: string; percent: number }> = []
	for (const line of output.split('\n')) {
		const match = line.match(/^([^\s|]+)\s*\|\s*(\d+(?:\.\d+)?)\s*%/)
		if (!match?.[1] || !match[2]) {
			continue
		}
		const file = match[1].trim()
		const fileCoverage = Number.parseFloat(match[2])
		if (fileCoverage < COVERAGE_LOW_THRESHOLD && file.endsWith('.ts')) {
			uncovered.push({ file, percent: fileCoverage })
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
		return JSON.stringify(compactSummaryForJsonText(summary))
	}

	if (summary.failed === 0) {
		return context
			? `All ${summary.passed} tests passed in ${context}.`
			: `All ${summary.passed} tests passed.`
	}

	let output = `${summary.failed} tests failed${context ? ` in ${context}` : ''} (${summary.passed} passed)\n\n`
	const commonFile = getCommonFailureFile(summary.failures)
	if (commonFile) {
		output += `File: ${commonFile}\n\n`
	}
	for (let index = 0; index < summary.failures.length; index += 1) {
		const failure = summary.failures[index]
		if (!failure) {
			continue
		}
		const locationPrefix = commonFile ? '' : `${failure.file}:`
		output += `${index + 1}. ${locationPrefix}${failure.line ?? '?'}\n`
		output += `   ${failure.message.split('\n')[0]}\n`
		if (failure.stack) {
			output += `      ${extractTopStackFrame(failure.stack)}\n`
		}
		output += '\n'
	}

	return output.trim()
}

function getCommonFailureFile(
	failures: z.infer<typeof failureSchema>[],
): string | null {
	if (failures.length === 0) {
		return null
	}
	const firstFile = failures[0]?.file
	if (!firstFile) {
		return null
	}
	return failures.every((failure) => failure.file === firstFile)
		? firstFile
		: null
}

export function extractTopStackFrame(stack: string): string {
	const lines = stack
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	const topFrame = lines.find((line) => line.startsWith('at '))
	return topFrame ?? lines[0] ?? stack
}

export function compactSummaryForJsonText(
	summary: z.infer<typeof testSummarySchema>,
): Record<string, unknown> {
	const commonFile = getCommonFailureFile(summary.failures)
	if (!commonFile) {
		return stripNullishDeep(summary)
	}
	return stripNullishDeep({
		passed: summary.passed,
		failed: summary.failed,
		total: summary.total,
		commonFile,
		failures: summary.failures.map((failure) => ({
			line: failure.line,
			message: failure.message,
			stack: failure.stack,
		})),
	})
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
		output += `\nFiles with low coverage (<${COVERAGE_LOW_THRESHOLD}%):\n`
		for (const entry of result.coverage.uncovered) {
			output += `   - ${entry.file} (${entry.percent}%)\n`
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
export async function createBunServer(
	options?: BunServerOptions,
): Promise<McpServer> {
	const observabilityState: ObservabilityState = {
		clientMcpLogLevel: DEFAULT_MCP_LOG_LEVEL,
	}

	const server = new McpServer(
		{
			name: 'bun-runner',
			version: SERVER_VERSION,
		},
		{
			capabilities: {
				logging: {},
			},
		},
	)
	await setupObservability(server, observabilityState, options)

	const lifecycleLogger = getLogger(['mcp', 'lifecycle'])
	const runTestsLogger = getLogger(['mcp', 'tools', 'bun_runTests'])
	const testFileLogger = getLogger(['mcp', 'tools', 'bun_testFile'])
	const coverageLogger = getLogger(['mcp', 'tools', 'bun_testCoverage'])

	server.server.setRequestHandler(
		SetLevelRequestSchema,
		async (request): Promise<Record<string, never>> => {
			observabilityState.clientMcpLogLevel = request.params.level
			runTestsLogger.info('Updated MCP logging level', {
				mcpLevel: request.params.level,
			})
			return {}
		},
	)

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
		async (args, extra): Promise<CallToolResult> => {
			return withContext(
				{
					requestId: String(extra.requestId),
					tool: 'bun_runTests',
				},
				async () => {
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
						runTestsLogger.info('bun_runTests completed', {
							passed: summary.passed,
							failed: summary.failed,
							total: summary.total,
						})
						return createToolSuccess(
							formatTestSummary(summary, format),
							summary,
						)
					} catch (error) {
						const failure = toToolFailure(error)
						runTestsLogger.error('bun_runTests failed', {
							code: failure.code,
							message: failure.message,
						})
						return createToolFailure(failure)
					}
				},
			)
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
		async (args, extra): Promise<CallToolResult> => {
			return withContext(
				{
					requestId: String(extra.requestId),
					tool: 'bun_testFile',
				},
				async () => {
					try {
						const validatedFile = await validatePath(args.file)
						const summary = await runBunTests(validatedFile)
						const format = args.response_format ?? 'json'
						testFileLogger.info('bun_testFile completed', {
							file: args.file,
							passed: summary.passed,
							failed: summary.failed,
						})
						return createToolSuccess(
							formatTestSummary(summary, format, args.file),
							summary,
						)
					} catch (error) {
						const failure = toToolFailure(error)
						testFileLogger.error('bun_testFile failed', {
							code: failure.code,
							message: failure.message,
							file: args.file,
						})
						return createToolFailure(failure)
					}
				},
			)
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
		async (args, extra): Promise<CallToolResult> => {
			return withContext(
				{
					requestId: String(extra.requestId),
					tool: 'bun_testCoverage',
				},
				async () => {
					try {
						const result = await runBunTestCoverage()
						const format = args.response_format ?? 'json'
						coverageLogger.info('bun_testCoverage completed', {
							failed: result.summary.failed,
							passed: result.summary.passed,
							coveragePercent: result.coverage.percent,
						})
						return createToolSuccess(
							formatCoverageResult(result, format),
							result,
						)
					} catch (error) {
						const failure = toToolFailure(error)
						coverageLogger.error('bun_testCoverage failed', {
							code: failure.code,
							message: failure.message,
						})
						return createToolFailure(failure)
					}
				},
			)
		},
	)

	lifecycleLogger.info('bun-runner server initialized', {
		version: SERVER_VERSION,
		defaultMcpLogLevel: observabilityState.clientMcpLogLevel,
	})

	return server
}

/**
 * Default parent-liveness poll interval in milliseconds.
 */
export const DEFAULT_PARENT_CHECK_MS = 5000

/**
 * Lower bound for the poll interval to prevent event-loop saturation.
 */
export const MIN_PARENT_CHECK_MS = 50

/**
 * Parse the MCP_PARENT_CHECK_MS env value into a poll interval.
 *
 * Returns 0 to disable the watcher entirely. Otherwise returns the clamped
 * positive interval. Unparseable / empty / NaN values fall back to the default.
 */
export function parseParentCheckMs(raw: string | undefined): number {
	if (raw === undefined) {
		return DEFAULT_PARENT_CHECK_MS
	}
	const trimmed = raw.trim()
	if (trimmed === '') {
		return DEFAULT_PARENT_CHECK_MS
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) {
		return DEFAULT_PARENT_CHECK_MS
	}
	if (parsed <= 0) {
		return 0
	}
	return Math.max(parsed, MIN_PARENT_CHECK_MS)
}

/**
 * Watch for parent-process death and invoke onParentDeath when detected.
 *
 * On macOS the SDK's stdin EOF is unreliable when the parent is SIGKILLed,
 * leaving the runner reparented to PID 1 and orphaned. Polling process.ppid
 * is the simplest reliable backstop.
 *
 * The returned interval handle is unref()'d so it never keeps the event loop
 * alive on its own. Returns undefined when the watcher is disabled.
 */
export function createParentLivenessWatcher(opts: {
	initialPpid: number
	getPpid: () => number
	onParentDeath: () => void
	intervalMs: number
}): ReturnType<typeof setInterval> | undefined {
	if (opts.intervalMs <= 0) {
		return undefined
	}
	const handle = setInterval(() => {
		const current = opts.getPpid()
		if (current !== opts.initialPpid || current === 1) {
			opts.onParentDeath()
		}
	}, opts.intervalMs)
	handle.unref()
	return handle
}

/**
 * Start the stdio MCP server process.
 */
export async function startBunServer(): Promise<void> {
	const server = await createBunServer()
	const transport = new StdioServerTransport()
	let shuttingDown = false
	const lifecycleLogger = getLogger(['mcp', 'lifecycle'])

	const shutdown = async () => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		lifecycleLogger.info('Shutting down bun-runner server')
		try {
			await dispose()
		} catch (error) {
			lifecycleLogger.error('Failed to dispose logger sinks cleanly', {
				error: error instanceof Error ? error.message : String(error),
			})
		}
		await server.close()
		process.exit(0)
	}

	transport.onclose = () => {
		void shutdown()
	}

	await server.connect(transport)
	lifecycleLogger.info('bun-runner server connected to stdio transport')
	process.stdin.resume()

	process.on('SIGINT', () => {
		void shutdown()
	})
	process.on('SIGTERM', () => {
		void shutdown()
	})

	const initialPpid = process.ppid
	const intervalMs = parseParentCheckMs(process.env.MCP_PARENT_CHECK_MS)
	createParentLivenessWatcher({
		initialPpid,
		getPpid: () => process.ppid,
		intervalMs,
		onParentDeath: () => {
			lifecycleLogger.info('Parent process gone, shutting down', {
				initialPpid,
				currentPpid: process.ppid,
			})
			void shutdown()
		},
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
