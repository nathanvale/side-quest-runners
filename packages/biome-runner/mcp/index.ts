#!/usr/bin/env bun

/// <reference types="bun-types" />

/**
 * Biome Linter & Formatter MCP Server
 *
 * Provides tools to run Biome linting and formatting with structured output.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
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

export interface LintDiagnostic {
	file: string
	message: string
	code: string
	line: number
	severity: 'error' | 'warning' | 'info'
	suggestion?: string | null
}

export interface LintSummary {
	errorCount: number
	warningCount: number
	diagnostics: LintDiagnostic[]
}

/** Shape of Biome's JSON reporter output */
interface BiomeReport {
	diagnostics?: Array<{
		severity?: string
		location?: {
			path?: { file?: string }
			span?: { start?: { line?: number } }
		}
		description?: string
		message?: string
		category?: string
		advice?: unknown
	}>
	summary?: { errors?: number; warnings?: number }
}

const BIOME_TIMEOUT_MS = 30_000
const BIOME_OUTPUT_CAPTURE_MAX_BYTES = 16 * 1024 * 1024
const BIOME_MAX_DIAGNOSTICS = 200
const BIOME_ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'NODE_PATH',
	'BUN_INSTALL',
	'TMPDIR',
] as const
const TOOL_ERROR_CODES = ['SPAWN_FAILURE', 'PATH_NOT_FOUND'] as const

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

class BiomeToolError extends Error {
	code: ToolErrorCode

	constructor(code: ToolErrorCode, message: string) {
		super(message)
		this.code = code
	}
}

interface ObservabilityState {
	clientMcpLogLevel: LoggingLevel
}

interface BiomeServerOptions {
	stderrStream?: WritableStream
}

const lintDiagnosticSchema: z.ZodObject<{
	file: z.ZodString
	message: z.ZodString
	code: z.ZodString
	line: z.ZodNumber
	severity: z.ZodEnum<['error', 'warning', 'info']>
	suggestion: z.ZodNullable<z.ZodOptional<z.ZodString>>
}> = z.object({
	file: z.string(),
	message: z.string(),
	code: z.string(),
	line: z.number(),
	severity: z.enum(['error', 'warning', 'info']),
	suggestion: z.string().optional().nullable(),
})

const lintSummarySchema: z.ZodObject<{
	errorCount: z.ZodNumber
	warningCount: z.ZodNumber
	diagnostics: z.ZodArray<typeof lintDiagnosticSchema>
}> = z.object({
	errorCount: z.number(),
	warningCount: z.number(),
	diagnostics: z.array(lintDiagnosticSchema),
})

const lintFixSchema: z.ZodObject<{
	fixed: z.ZodNumber
	remaining: typeof lintSummarySchema
}> = z.object({
	fixed: z.number(),
	remaining: lintSummarySchema,
})

const formatCheckSchema: z.ZodObject<{
	formatted: z.ZodBoolean
	unformattedFiles: z.ZodArray<z.ZodString>
}> = z.object({
	formatted: z.boolean(),
	unformattedFiles: z.array(z.string()),
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
 * Why: validation executes for every tool call and concurrent requests should
 * share one subprocess instead of spawning duplicate `git rev-parse` calls.
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
 * Validate optional path input and default to cwd.
 *
 * Why: callers frequently omit or send blank paths; we still enforce all
 * boundary checks before invoking biome.
 */
export async function validatePathOrDefault(
	inputPath?: string,
): Promise<string> {
	const candidate =
		inputPath === undefined || inputPath.trim() === ''
			? process.cwd()
			: inputPath
	return validatePath(candidate)
}

/**
 * Validate path input against traversal and repository-escape vectors.
 *
 * Why: biome commands execute against paths and must never read/write outside
 * the current repository boundary.
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

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || code === 0x7f) {
			return true
		}
	}
	return false
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
 * Parse Biome JSON output to extract lint diagnostics.
 */
export function parseBiomeOutput(stdout: string): LintSummary {
	try {
		const report = JSON.parse(stdout) as BiomeReport
		const diagnostics: LintDiagnostic[] = []

		if (report.diagnostics) {
			for (const diagnostic of report.diagnostics) {
				if (
					diagnostic.severity === 'error' ||
					diagnostic.severity === 'warning'
				) {
					diagnostics.push({
						file: diagnostic.location?.path?.file || 'unknown',
						line: diagnostic.location?.span?.start?.line || 0,
						message: diagnostic.description || diagnostic.message || 'unknown',
						code: diagnostic.category || 'unknown',
						severity: diagnostic.severity,
						suggestion: diagnostic.advice
							? JSON.stringify(diagnostic.advice)
							: null,
					})
				}
			}
		}

		const summary = report.summary || {}

		return {
			errorCount:
				summary.errors ??
				diagnostics.filter((entry) => entry.severity === 'error').length,
			warningCount:
				summary.warnings ??
				diagnostics.filter((entry) => entry.severity === 'warning').length,
			diagnostics,
		}
	} catch {
		return {
			errorCount: 1,
			warningCount: 0,
			diagnostics: [
				{
					file: 'unknown',
					line: 0,
					message: `Failed to parse Biome JSON output: ${stdout.substring(0, 200)}`,
					code: 'internal_error',
					severity: 'error',
					suggestion: null,
				},
			],
		}
	}
}

/**
 * Build biome invocation command and sanitized environment.
 *
 * Why: spawn reliability and env-leak prevention should be testable as a pure
 * function without running subprocesses.
 */
export function createBiomeInvocation(args: {
	subcommand: 'check' | 'format'
	path: string
	write?: boolean
}): { cmd: string[]; env: Record<string, string> } {
	const env: Record<string, string> = { CI: 'true' }
	for (const key of BIOME_ENV_ALLOWLIST) {
		const value = process.env[key]
		if (typeof value === 'string' && value.length > 0) {
			env[key] = value
		}
	}

	const cmd = ['bunx', '@biomejs/biome', args.subcommand]
	if (args.write) {
		cmd.push('--write')
	}
	cmd.push(
		'--reporter=json',
		`--max-diagnostics=${BIOME_MAX_DIAGNOSTICS}`,
		args.path,
	)
	return { cmd, env }
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
	options?: BiomeServerOptions,
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
	if (error instanceof BiomeToolError) {
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
 * Spawn a subprocess and enforce timeout with SIGTERM -> SIGKILL escalation.
 *
 * Why: biome-runner tools must remain responsive even when underlying commands hang.
 */
export async function spawnWithTimeout(
	cmd: string[],
	options?: {
		cwd?: string
		env?: Record<string, string>
		timeoutMs?: number
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
				cwd: options?.cwd,
				env: options?.env,
				stdout: 'pipe',
				stderr: 'pipe',
			})
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			throw new BiomeToolError(
				'SPAWN_FAILURE',
				`Failed to start Biome command: ${message}`,
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
	}, options?.timeoutMs ?? BIOME_TIMEOUT_MS)

	const maxBytes = options?.maxBytes ?? BIOME_OUTPUT_CAPTURE_MAX_BYTES
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

async function ensurePathExists(validatedPath: string): Promise<void> {
	try {
		await stat(validatedPath)
	} catch (error) {
		const code =
			typeof error === 'object' && error !== null && 'code' in error
				? String((error as { code?: unknown }).code)
				: ''
		if (code === 'ENOENT') {
			throw new BiomeToolError(
				'PATH_NOT_FOUND',
				`Path not found: ${validatedPath}`,
			)
		}
		if (code === 'EACCES' || code === 'EPERM') {
			throw new BiomeToolError(
				'SPAWN_FAILURE',
				`Permission denied while accessing path: ${validatedPath}`,
			)
		}
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Unable to access path: ${validatedPath}`,
		)
	}
}

async function runBiomeCheck(inputPath = '.'): Promise<LintSummary> {
	const invocation = createBiomeInvocation({
		subcommand: 'check',
		path: inputPath,
	})
	const { stdout, stderr, timedOut, stdoutTruncated, stderrTruncated } =
		await spawnWithTimeout(invocation.cmd, {
			env: invocation.env,
			timeoutMs: BIOME_TIMEOUT_MS,
		})

	if (timedOut) {
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Biome check timed out after ${BIOME_TIMEOUT_MS / 1000}s`,
		)
	}
	if (stdoutTruncated || stderrTruncated) {
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Biome output exceeded ${BIOME_OUTPUT_CAPTURE_MAX_BYTES} bytes. Narrow the path or reduce diagnostics.`,
		)
	}

	return parseBiomeOutput(stdout || stderr)
}

async function runBiomeFix(
	inputPath = '.',
): Promise<z.infer<typeof lintFixSchema>> {
	// biome check --write applies both formatting and lint fixes in one pass.
	// We keep one post-fix check subprocess to return remaining diagnostics.
	const fixInvocation = createBiomeInvocation({
		subcommand: 'check',
		path: inputPath,
		write: true,
	})
	const fix = await spawnWithTimeout(fixInvocation.cmd, {
		env: fixInvocation.env,
		timeoutMs: BIOME_TIMEOUT_MS,
	})

	if (fix.timedOut) {
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Biome check --write timed out after ${BIOME_TIMEOUT_MS / 1000}s`,
		)
	}
	if (fix.stdoutTruncated || fix.stderrTruncated) {
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Biome output exceeded ${BIOME_OUTPUT_CAPTURE_MAX_BYTES} bytes during --write. Narrow the path or reduce diagnostics.`,
		)
	}

	const remaining = await runBiomeCheck(inputPath)

	const report = parseBiomeOutput(fix.stdout || fix.stderr)
	const fixed = Math.max(
		0,
		report.errorCount +
			report.warningCount -
			(remaining.errorCount + remaining.warningCount),
	)

	return {
		fixed,
		remaining,
	}
}

async function runBiomeFormatCheck(
	inputPath = '.',
): Promise<z.infer<typeof formatCheckSchema>> {
	const invocation = createBiomeInvocation({
		subcommand: 'format',
		path: inputPath,
	})
	const { stdout, exitCode, timedOut, stdoutTruncated, stderrTruncated } =
		await spawnWithTimeout(invocation.cmd, {
			env: invocation.env,
			timeoutMs: BIOME_TIMEOUT_MS,
		})

	if (timedOut) {
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Biome format check timed out after ${BIOME_TIMEOUT_MS / 1000}s`,
		)
	}
	if (stdoutTruncated || stderrTruncated) {
		throw new BiomeToolError(
			'SPAWN_FAILURE',
			`Biome output exceeded ${BIOME_OUTPUT_CAPTURE_MAX_BYTES} bytes during format check. Narrow the path or reduce diagnostics.`,
		)
	}

	if (exitCode === 0) {
		return { formatted: true, unformattedFiles: [] }
	}

	const unformattedFiles: string[] = []
	try {
		const report = JSON.parse(stdout) as BiomeReport
		if (report.diagnostics) {
			for (const diagnostic of report.diagnostics) {
				const file = diagnostic.location?.path?.file
				if (file && !unformattedFiles.includes(file)) {
					unformattedFiles.push(file)
				}
			}
		}
	} catch {
		// Parse failures still indicate files are not formatted.
	}

	return { formatted: false, unformattedFiles }
}

function formatLintSummary(
	summary: LintSummary,
	format: 'markdown' | 'json',
): string {
	if (format === 'json') {
		return JSON.stringify(compactLintSummaryForJsonText(summary))
	}

	if (summary.errorCount === 0 && summary.warningCount === 0) {
		return 'No linting issues found.'
	}

	let output = `Found ${summary.errorCount} errors and ${summary.warningCount} warnings:\n\n`
	const commonFile = getCommonDiagnosticFile(summary.diagnostics)
	if (commonFile) {
		output += `File: ${commonFile}\n\n`
	}

	for (const diagnostic of summary.diagnostics) {
		const icon = diagnostic.severity === 'error' ? '[error]' : '[warn]'
		const location = commonFile
			? `${diagnostic.line}`
			: `${diagnostic.file}:${diagnostic.line}`
		output += `${icon} ${location} [${diagnostic.code}]\n`
		output += `   ${diagnostic.message}\n`
		if (diagnostic.suggestion) {
			output += '   Suggestion available\n'
		}
		output += '\n'
	}

	return output.trim()
}

function formatLintFixResult(
	result: z.infer<typeof lintFixSchema>,
	format: 'markdown' | 'json',
): string {
	if (format === 'json') {
		return JSON.stringify(compactLintFixResultForJsonText(result))
	}

	let output = ''
	if (result.fixed > 0) {
		output += `Fixed ${result.fixed} issue(s)\n\n`
	}

	if (
		result.remaining.errorCount === 0 &&
		result.remaining.warningCount === 0
	) {
		return output ? `${output}All issues resolved.`.trim() : 'No issues to fix.'
	}

	output += `${result.remaining.errorCount} error(s) and ${result.remaining.warningCount} warning(s) remain:\n\n`
	const commonFile = getCommonDiagnosticFile(result.remaining.diagnostics)
	if (commonFile) {
		output += `File: ${commonFile}\n\n`
	}
	for (const diagnostic of result.remaining.diagnostics) {
		const icon = diagnostic.severity === 'error' ? '[error]' : '[warn]'
		const location = commonFile
			? `${diagnostic.line}`
			: `${diagnostic.file}:${diagnostic.line}`
		output += `${icon} ${location} [${diagnostic.code}]\n`
		output += `   ${diagnostic.message}\n\n`
	}

	return output.trim()
}

function getCommonDiagnosticFile(diagnostics: LintDiagnostic[]): string | null {
	if (diagnostics.length === 0) {
		return null
	}
	const first = diagnostics[0]?.file
	if (!first) {
		return null
	}
	return diagnostics.every((diagnostic) => diagnostic.file === first)
		? first
		: null
}

export function compactLintSummaryForJsonText(
	summary: LintSummary,
): Record<string, unknown> {
	const commonFile = getCommonDiagnosticFile(summary.diagnostics)
	if (!commonFile) {
		return stripNullishDeep(summary) as unknown as Record<string, unknown>
	}
	return stripNullishDeep({
		errorCount: summary.errorCount,
		warningCount: summary.warningCount,
		commonFile,
		diagnostics: summary.diagnostics.map((diagnostic) => ({
			line: diagnostic.line,
			message: diagnostic.message,
			code: diagnostic.code,
			severity: diagnostic.severity,
			suggestion: diagnostic.suggestion,
		})),
	})
}

export function compactLintFixResultForJsonText(
	result: z.infer<typeof lintFixSchema>,
): Record<string, unknown> {
	return stripNullishDeep({
		fixed: result.fixed,
		remaining: compactLintSummaryForJsonText(result.remaining),
	}) as Record<string, unknown>
}

function formatFormatCheckResult(
	result: z.infer<typeof formatCheckSchema>,
	format: 'markdown' | 'json',
): string {
	if (format === 'json') {
		return JSON.stringify(result)
	}

	if (result.formatted) {
		return 'All files are properly formatted.'
	}

	let output = `${result.unformattedFiles.length} file(s) need formatting:\n\n`
	for (const file of result.unformattedFiles) {
		output += `   - ${file}\n`
	}
	output += '\nRun biome_lintFix to auto-format these files.'
	return output.trim()
}

/**
 * Create the biome-runner MCP server.
 *
 * Why: factory construction enables direct InMemoryTransport integration tests.
 */
export async function createBiomeServer(
	options?: BiomeServerOptions,
): Promise<McpServer> {
	const observabilityState: ObservabilityState = {
		clientMcpLogLevel: DEFAULT_MCP_LOG_LEVEL,
	}

	const server = new McpServer(
		{
			name: 'biome-runner',
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
	const lintCheckLogger = getLogger(['mcp', 'tools', 'biome_lintCheck'])
	const lintFixLogger = getLogger(['mcp', 'tools', 'biome_lintFix'])
	const formatCheckLogger = getLogger(['mcp', 'tools', 'biome_formatCheck'])

	server.server.setRequestHandler(
		SetLevelRequestSchema,
		async (request): Promise<Record<string, never>> => {
			observabilityState.clientMcpLogLevel = request.params.level
			lintCheckLogger.info('Updated MCP logging level', {
				mcpLevel: request.params.level,
			})
			return {}
		},
	)

	server.registerTool(
		'biome_lintCheck',
		{
			title: 'Biome Lint Checker',
			description:
				'Check files with Biome and return lint/format diagnostics without writing changes. Use after edits. Read-only. No fixes or type checks. Use biome_lintFix to fix; use tsc_check for types.',
			inputSchema: z.object({
				path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						'Path to file or directory to check (default: current directory)',
					),
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: lintSummarySchema,
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
					tool: 'biome_lintCheck',
				},
				async () => {
					try {
						const validatedPath = await validatePathOrDefault(args.path)
						await ensurePathExists(validatedPath)
						const summary = await runBiomeCheck(validatedPath)
						const format = args.response_format
						lintCheckLogger.info('biome_lintCheck completed', {
							path: validatedPath,
							errorCount: summary.errorCount,
							warningCount: summary.warningCount,
						})
						return createToolSuccess(
							formatLintSummary(summary, format),
							summary,
						)
					} catch (error) {
						const failure = toToolFailure(error)
						lintCheckLogger.error('biome_lintCheck failed', {
							code: failure.code,
							message: failure.message,
							path: args.path ?? null,
						})
						return createToolFailure(failure)
					}
				},
			)
		},
	)

	server.registerTool(
		'biome_lintFix',
		{
			title: 'Biome Lint & Format Fixer',
			description:
				'Auto-fix Biome lint/format issues with --write, then return remaining diagnostics. Use after biome_lintCheck. Modifies files. No type checks. Use biome_lintCheck for read-only checks; use tsc_check for types.',
			inputSchema: z.object({
				path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						'Path to file or directory to fix (default: current directory)',
					),
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: lintFixSchema,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false,
			},
		},
		async (args, extra): Promise<CallToolResult> => {
			return withContext(
				{
					requestId: String(extra.requestId),
					tool: 'biome_lintFix',
				},
				async () => {
					try {
						const validatedPath = await validatePathOrDefault(args.path)
						await ensurePathExists(validatedPath)
						const result = await runBiomeFix(validatedPath)
						const format = args.response_format
						lintFixLogger.info('biome_lintFix completed', {
							path: validatedPath,
							fixed: result.fixed,
							remainingErrors: result.remaining.errorCount,
							remainingWarnings: result.remaining.warningCount,
						})
						return createToolSuccess(
							formatLintFixResult(result, format),
							result,
						)
					} catch (error) {
						const failure = toToolFailure(error)
						lintFixLogger.error('biome_lintFix failed', {
							code: failure.code,
							message: failure.message,
							path: args.path ?? null,
						})
						return createToolFailure(failure)
					}
				},
			)
		},
	)

	server.registerTool(
		'biome_formatCheck',
		{
			title: 'Biome Format Checker',
			description:
				'Check Biome formatting compliance and list unformatted files. Use for CI/pre-commit format gates. Read-only. No fixes or type checks. Use biome_lintFix to fix formatting; biome_lintCheck for lint diagnostics.',
			inputSchema: z.object({
				path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						'Path to file or directory to check (default: current directory)',
					),
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: formatCheckSchema,
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
					tool: 'biome_formatCheck',
				},
				async () => {
					try {
						const validatedPath = await validatePathOrDefault(args.path)
						await ensurePathExists(validatedPath)
						const result = await runBiomeFormatCheck(validatedPath)
						const format = args.response_format
						formatCheckLogger.info('biome_formatCheck completed', {
							path: validatedPath,
							formatted: result.formatted,
							unformattedCount: result.unformattedFiles.length,
						})
						return createToolSuccess(
							formatFormatCheckResult(result, format),
							result,
						)
					} catch (error) {
						const failure = toToolFailure(error)
						formatCheckLogger.error('biome_formatCheck failed', {
							code: failure.code,
							message: failure.message,
							path: args.path ?? null,
						})
						return createToolFailure(failure)
					}
				},
			)
		},
	)

	lifecycleLogger.info('biome-runner server initialized', {
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
	isParentAlive?: (pid: number) => boolean
	onParentDeath: () => void
	intervalMs: number
}): ReturnType<typeof setInterval> | undefined {
	if (opts.intervalMs <= 0) {
		return undefined
	}
	const handle = setInterval(() => {
		const current = opts.getPpid()
		if (
			current !== opts.initialPpid ||
			opts.isParentAlive?.(opts.initialPpid) === false
		) {
			clearInterval(handle)
			opts.onParentDeath()
		}
	}, opts.intervalMs)
	handle.unref()
	return handle
}

/**
 * Check whether a process exists without sending it a real signal.
 *
 * Why: Bun's process.ppid can retain its startup value after reparenting, so
 * the watcher also probes the original parent PID directly.
 */
export function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

/**
 * Start the stdio MCP server process.
 */
export async function startBiomeServer(): Promise<void> {
	const server = await createBiomeServer()
	const transport = new StdioServerTransport()
	let shuttingDown = false
	const lifecycleLogger = getLogger(['mcp', 'lifecycle'])

	const shutdown = async () => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		lifecycleLogger.info('Shutting down biome-runner server')
		try {
			await dispose()
		} catch (error) {
			lifecycleLogger.error('Failed to dispose logger sinks cleanly', {
				error: error instanceof Error ? error.message : String(error),
			})
		}
		try {
			await server.close()
		} catch (error) {
			lifecycleLogger.error('Failed to close biome-runner server cleanly', {
				error: error instanceof Error ? error.message : String(error),
			})
		} finally {
			process.exit(0)
		}
	}

	transport.onclose = () => {
		void shutdown()
	}

	await server.connect(transport)
	lifecycleLogger.info('biome-runner server connected to stdio transport')
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
		isParentAlive: isPidAlive,
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

if (import.meta.main) {
	void startBiomeServer()
}
