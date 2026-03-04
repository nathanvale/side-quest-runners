#!/usr/bin/env bun

/// <reference types="bun-types" />

/**
 * TypeScript checker MCP server.
 *
 * Runs `bunx tsc --noEmit --pretty false` from the nearest tsconfig/jsconfig
 * and reports errors in a Claude-friendly format.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
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
import {
	type CallToolResult,
	type LoggingLevel,
	SetLevelRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * Bridge Zod-inferred output types to the SDK's Record<string, unknown>.
 *
 * Why: CallToolResult.structuredContent is typed as Record<string, unknown>,
 * but our explicit interfaces have concrete keys that TypeScript considers
 * structurally incompatible. This helper centralizes the unavoidable cast.
 */
function toStructured(value: object): Record<string, unknown> {
	return value as Record<string, unknown>
}

/** Valid TypeScript configuration file names */
const TSC_CONFIG_FILES = ['tsconfig.json', 'jsconfig.json'] as const
const TSC_TIMEOUT_MS = 30_000
const TSC_ENV_ALLOWLIST = [
	'PATH',
	'HOME',
	'NODE_PATH',
	'BUN_INSTALL',
	'TMPDIR',
] as const

const TOOL_ERROR_CODES = [
	'CONFIG_NOT_FOUND',
	'TIMEOUT',
	'SPAWN_FAILURE',
	'PATH_NOT_FOUND',
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

export interface TscError {
	file: string
	line: number
	col: number
	code: string
	message: string
}

export interface TscOutput {
	cwd: string
	configPath: string
	timedOut: boolean
	exitCode: number
	errors: TscError[]
	errorCount: number
	parseWarning?: string
	rawStderr?: string
	remediationHint?: string
}

export interface TscParseResult {
	errorCount: number
	errors: TscError[]
}

const tscOutputSchema: z.ZodType<TscOutput> = z.object({
	cwd: z.string(),
	configPath: z.string(),
	timedOut: z.boolean(),
	exitCode: z.number(),
	errors: z.array(
		z.object({
			file: z.string(),
			line: z.number(),
			col: z.number(),
			code: z.string(),
			message: z.string(),
		}),
	),
	errorCount: z.number(),
	parseWarning: z.string().optional(),
	rawStderr: z.string().optional(),
	remediationHint: z.string().optional(),
})

interface ToolFailure {
	code: ToolErrorCode
	message: string
	remediationHint?: string
}

class TscToolError extends Error {
	code: ToolErrorCode
	remediationHint?: string

	constructor(code: ToolErrorCode, message: string, remediationHint?: string) {
		super(message)
		this.code = code
		this.remediationHint = remediationHint
	}
}

interface ObservabilityState {
	clientMcpLogLevel: LoggingLevel
}

interface TscServerOptions {
	stderrStream?: WritableStream
}

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
 * Why: all path validators need a stable repository boundary, and sharing
 * one subprocess result avoids redundant `git rev-parse` calls under
 * concurrent tool invocations.
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
 *
 * Why: tests may stub process state and need deterministic isolation.
 */
export function _resetGitRootCache(): void {
	_gitRootPromise = null
}

/**
 * Validate a potentially-empty path and default to cwd when omitted.
 *
 * Why: MCP callers may send empty strings for optional path arguments, and we
 * treat that as "use current repository context" while still enforcing all
 * path traversal and control-character protections.
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
 * Validate and canonicalize a path while enforcing repository boundaries.
 *
 * Why: defense-in-depth against traversal, control-byte injection, and symlink
 * escapes before any filesystem reads or command execution.
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
 * Parse TypeScript compiler output into structured format.
 *
 * @param output - Raw stdout/stderr from tsc command
 * @returns Structured error data with count and detailed error array
 */
export function parseTscOutput(output: string): TscParseResult {
	const errors: TscError[] = []

	const errorPattern = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/gm
	const matches = output.matchAll(errorPattern)

	for (const match of matches) {
		const [, file, line, col, code, message] = match
		if (file && line && col && code && message) {
			errors.push({
				file,
				line: Number.parseInt(line, 10),
				col: Number.parseInt(col, 10),
				code,
				message,
			})
		}
	}

	return { errorCount: errors.length, errors }
}

/**
 * Find nearest tsconfig/jsconfig bounded to the current git root.
 *
 * Why: unbounded upward traversal can leak repository context and hit unrelated
 * configs outside the project boundary.
 */
export async function findNearestTsConfig(filePath: string): Promise<{
	found: boolean
	configDir?: string
	configPath?: string
}> {
	const gitRoot = await getGitRoot()
	let current = path.dirname(path.resolve(filePath))

	if (current !== gitRoot && !current.startsWith(`${gitRoot}/`)) {
		return { found: false }
	}

	while (current === gitRoot || current.startsWith(`${gitRoot}/`)) {
		for (const configFile of TSC_CONFIG_FILES) {
			const candidatePath = path.join(current, configFile)
			if (await fileExists(candidatePath)) {
				return {
					found: true,
					configDir: current,
					configPath: candidatePath,
				}
			}
		}

		if (current === gitRoot) {
			break
		}

		const parent = path.dirname(current)
		if (parent === current) {
			break
		}
		current = parent
	}

	return { found: false }
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

async function resolveWorkdir(targetPath?: string): Promise<{
	cwd: string
	configPath: string
}> {
	const resolved = await validatePathOrDefault(targetPath)

	if (!(await fileExists(resolved))) {
		throw new TscToolError('PATH_NOT_FOUND', `Path not found: ${resolved}`)
	}

	const fileStat = await stat(resolved)

	if (fileStat.isDirectory()) {
		for (const candidate of TSC_CONFIG_FILES) {
			const candidatePath = path.join(resolved, candidate)
			if (await fileExists(candidatePath)) {
				return { cwd: resolved, configPath: candidatePath }
			}
		}

		const nearest = await findNearestTsConfig(path.join(resolved, 'index.ts'))
		if (nearest.found && nearest.configDir && nearest.configPath) {
			return { cwd: nearest.configDir, configPath: nearest.configPath }
		}

		throw new TscToolError(
			'CONFIG_NOT_FOUND',
			`No tsconfig.json or jsconfig.json found for directory ${resolved}`,
		)
	}

	const nearest = await findNearestTsConfig(resolved)
	if (nearest.found && nearest.configDir && nearest.configPath) {
		return { cwd: nearest.configDir, configPath: nearest.configPath }
	}

	throw new TscToolError(
		'CONFIG_NOT_FOUND',
		`No tsconfig.json or jsconfig.json found for file ${resolved}`,
	)
}

async function spawnWithTimeout(
	cmd: string[],
	timeoutMs: number,
	options?: {
		cwd?: string
		env?: Record<string, string>
	},
): Promise<{
	stdout: string
	stderr: string
	exitCode: number
	timedOut: boolean
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
			throw new TscToolError(
				'SPAWN_FAILURE',
				`Failed to start TypeScript compiler: ${message}`,
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

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])

	clearTimeout(timeout)
	if (killTimer) clearTimeout(killTimer)
	return { stdout, stderr, exitCode, timedOut }
}

async function runTsc(cwd: string, configPath: string): Promise<TscOutput> {
	const invocation = createTscInvocation(configPath)

	const { stdout, stderr, exitCode, timedOut } = await spawnWithTimeout(
		invocation.cmd,
		TSC_TIMEOUT_MS,
		{
			cwd,
			env: invocation.env,
		},
	)

	if (timedOut) {
		throw new TscToolError(
			'TIMEOUT',
			`TypeScript check timed out after ${TSC_TIMEOUT_MS / 1000}s in ${cwd}.`,
		)
	}

	const lowerStderr = stderr.toLowerCase()
	if (
		exitCode !== 0 &&
		(lowerStderr.includes('command not found') ||
			lowerStderr.includes('not recognized') ||
			lowerStderr.includes('bunx: could not determine executable to run') ||
			lowerStderr.includes('enoent'))
	) {
		throw new TscToolError(
			'SPAWN_FAILURE',
			`Failed to start TypeScript compiler from ${cwd}: ${stderr.trim()}`,
		)
	}

	return buildTscOutput({
		cwd,
		configPath,
		stdout,
		stderr,
		exitCode,
		timedOut,
	})
}

/**
 * Build the exact `tsc` invocation command and sanitized environment.
 *
 * Why: reliability and security behavior (incremental mode + env allowlist)
 * should be testable without running subprocesses.
 */
export function createTscInvocation(configPath: string): {
	cmd: string[]
	env: Record<string, string>
} {
	const env: Record<string, string> = { CI: 'true' }
	for (const key of TSC_ENV_ALLOWLIST) {
		const value = process.env[key]
		if (typeof value === 'string' && value.length > 0) {
			env[key] = value
		}
	}

	return {
		cmd: [
			'bunx',
			'tsc',
			'--noEmit',
			'--pretty',
			'false',
			'--incremental',
			'--project',
			configPath,
		],
		env,
	}
}

/**
 * Convert raw compiler process outputs into structured `tsc_check` output.
 *
 * Why: parser fallback and corruption hinting are pure transformation logic
 * that should be deterministic and unit-testable.
 */
export function buildTscOutput(args: {
	cwd: string
	configPath: string
	stdout: string
	stderr: string
	exitCode: number
	timedOut: boolean
}): TscOutput {
	const parsed = parseTscOutput(`${args.stdout}${args.stderr}`)
	const corruptionHint = detectTsBuildInfoCorruption(
		`${args.stdout}\n${args.stderr}`,
	)
	if (args.exitCode !== 0 && parsed.errorCount === 0) {
		const fallbackMessage =
			args.stderr.trim() || args.stdout.trim() || 'No stderr output captured'
		const parseWarning =
			'TypeScript exited non-zero, but diagnostics could not be parsed from compiler output.'
		return {
			cwd: args.cwd,
			configPath: args.configPath,
			timedOut: args.timedOut,
			exitCode: args.exitCode,
			errors: [
				{
					file: args.configPath,
					line: 1,
					col: 1,
					code: 'TS_PARSE_FALLBACK',
					message: `${parseWarning} Raw stderr: ${fallbackMessage}`,
				},
			],
			errorCount: 1,
			parseWarning,
			rawStderr: fallbackMessage,
			remediationHint: corruptionHint ?? undefined,
		}
	}

	return {
		cwd: args.cwd,
		configPath: args.configPath,
		timedOut: args.timedOut,
		exitCode: args.exitCode,
		errors: parsed.errors,
		errorCount: parsed.errorCount,
		remediationHint: corruptionHint ?? undefined,
	}
}

/**
 * Detect probable TypeScript incremental cache corruption signatures.
 *
 * Why: concurrent `tsc --incremental` runs can leave damaged `.tsbuildinfo`
 * files; surfacing a remediation hint reduces repeat failures.
 */
export function detectTsBuildInfoCorruption(output: string): string | null {
	const normalized = output.toLowerCase()
	if (!normalized.includes('.tsbuildinfo')) {
		return null
	}

	if (
		normalized.includes('unexpected end of json input') ||
		normalized.includes('unterminated string in json') ||
		normalized.includes(
			"cannot read properties of undefined (reading 'version')",
		) ||
		normalized.includes("cannot read property 'version' of undefined") ||
		normalized.includes("property 'version' is missing")
	) {
		return 'Possible .tsbuildinfo corruption detected. Delete .tsbuildinfo and retry.'
	}

	return null
}

function toToolFailure(error: unknown): ToolFailure {
	if (error instanceof TscToolError) {
		return {
			code: error.code,
			message: error.message,
			remediationHint: error.remediationHint,
		}
	}

	const message = error instanceof Error ? error.message : String(error)
	return {
		code: 'SPAWN_FAILURE',
		message,
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

/**
 * Configure local observability sinks for this MCP server.
 *
 * Why: stdout must stay MCP-protocol-only, so we emit operator logs to stderr
 * JSONL and client-visible logs via notifications/message with explicit level
 * gating and request-scoped context isolation.
 */
async function setupObservability(
	server: McpServer,
	state: ObservabilityState,
	options?: TscServerOptions,
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

/**
 * Format tsc errors as human-readable markdown with per-error diagnostics.
 *
 * Why: markdown callers need actionable file:line:col locations inline,
 * not just a summary count.
 */
export function formatTscMarkdown(output: TscOutput): string {
	const lines = [
		`${output.errorCount} type error(s) (cwd: ${output.cwd})`,
		`Config: ${output.configPath}`,
		'',
	]
	for (const error of output.errors) {
		lines.push(`- ${error.file}:${error.line}:${error.col} - ${error.message}`)
	}
	return lines.join('\n')
}

/**
 * Create the tsc-runner MCP server.
 *
 * Why: factory construction keeps transport wiring out of tests so integration
 * coverage can use InMemoryTransport.
 */
export async function createTscServer(
	options?: TscServerOptions,
): Promise<McpServer> {
	const observabilityState: ObservabilityState = {
		clientMcpLogLevel: DEFAULT_MCP_LOG_LEVEL,
	}

	const server = new McpServer(
		{
			name: 'tsc-runner',
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
	const toolLogger = getLogger(['mcp', 'tools', 'tsc_check'])

	server.server.setRequestHandler(
		SetLevelRequestSchema,
		async (request): Promise<Record<string, never>> => {
			observabilityState.clientMcpLogLevel = request.params.level
			toolLogger.info('Updated MCP logging level', {
				mcpLevel: request.params.level,
			})
			return {}
		},
	)

	server.registerTool(
		'tsc_check',
		{
			title: 'TypeScript Type Checker',
			description:
				'Type-check TS/JS with tsc --noEmit using nearest tsconfig/jsconfig. Use after edits. Returns errorCount and file/line/column/message diagnostics. Read-only. Not for lint/format/tests; use biome_lintCheck or bun_runTests.',
			inputSchema: z.object({
				path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						'Optional file or directory to determine which tsconfig to use (default: current directory)',
					),
				response_format: z
					.enum(['markdown', 'json'])
					.optional()
					.default('json')
					.describe("Output format: 'markdown' or 'json' (default)"),
			}),
			outputSchema: tscOutputSchema,
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
					tool: 'tsc_check',
				},
				async () => {
					toolLogger.debug('Received tsc_check call', {
						path: args.path ?? null,
						responseFormat: args.response_format ?? 'json',
					})

					try {
						const { cwd, configPath } = await resolveWorkdir(args.path)
						const output = await runTsc(cwd, configPath)
						const format = args.response_format ?? 'json'

						const text =
							format === 'json'
								? JSON.stringify(output)
								: output.exitCode === 0 || output.errorCount === 0
									? `TypeScript passed (cwd: ${output.cwd})`
									: formatTscMarkdown(output)

						toolLogger.info('tsc_check completed', {
							cwd: output.cwd,
							configPath: output.configPath,
							exitCode: output.exitCode,
							errorCount: output.errorCount,
						})

						return {
							isError: false,
							content: [{ type: 'text', text }],
							structuredContent: toStructured(output),
						}
					} catch (error) {
						const failure = toToolFailure(error)
						toolLogger.error('tsc_check failed', {
							code: failure.code,
							message: failure.message,
							remediationHint: failure.remediationHint ?? null,
						})
						return {
							isError: true,
							content: [
								{
									type: 'text',
									text: `${failure.code}: ${failure.message}${failure.remediationHint ? `\n${failure.remediationHint}` : ''}`,
								},
							],
							structuredContent: toStructured(failure),
						}
					}
				},
			)
		},
	)

	lifecycleLogger.info('tsc-runner server initialized', {
		version: SERVER_VERSION,
		defaultMcpLogLevel: observabilityState.clientMcpLogLevel,
	})

	return server
}

/**
 * Start the stdio MCP server process.
 *
 * Why: explicit lifecycle wiring keeps shutdown reliable in CLI-hosted runs.
 */
export async function startTscServer(): Promise<void> {
	const server = await createTscServer()
	const transport = new StdioServerTransport()
	let shuttingDown = false
	const lifecycleLogger = getLogger(['mcp', 'lifecycle'])

	const shutdown = async () => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		lifecycleLogger.info('Shutting down tsc-runner server')
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
	lifecycleLogger.info('tsc-runner server connected to stdio transport')
	process.stdin.resume()

	process.on('SIGINT', () => {
		void shutdown()
	})
	process.on('SIGTERM', () => {
		void shutdown()
	})
}

if (import.meta.main) {
	void startTscServer()
}
