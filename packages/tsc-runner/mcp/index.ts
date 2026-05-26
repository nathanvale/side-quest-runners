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
const TSC_OUTPUT_CAPTURE_MAX_BYTES = 16 * 1024 * 1024
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
	cwd?: string
}

class TscToolError extends Error {
	code: ToolErrorCode
	remediationHint?: string
	cwd?: string

	constructor(
		code: ToolErrorCode,
		message: string,
		remediationHint?: string,
		cwd?: string,
	) {
		super(message)
		this.code = code
		this.remediationHint = remediationHint
		this.cwd = cwd
	}
}

interface ObservabilityState {
	clientMcpLogLevel: LoggingLevel
}

interface TscServerOptions {
	stderrStream?: WritableStream
	onRequestStart?: () => () => void
}

function startRequestActivity(options?: TscServerOptions): () => void {
	return options?.onRequestStart?.() ?? (() => {})
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
let _repositoryContextPromise: Promise<RepositoryContext> | null = null

interface RepositoryContext {
	worktreeRoot: string
	gitCommonDir: string
}

interface PathContext {
	realPath: string
	worktreeRoot: string
	startupRoot: string
	gitCommonDir: string
}

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
	_gitRootPromise = getStartupRepositoryContext().then(
		(context) => context.worktreeRoot,
	)
	return _gitRootPromise
}

async function getStartupRepositoryContext(): Promise<RepositoryContext> {
	if (_repositoryContextPromise !== null) {
		return _repositoryContextPromise
	}
	_repositoryContextPromise = resolveRepositoryContext(process.cwd())
	return _repositoryContextPromise
}

async function resolveRepositoryContext(
	cwd: string,
): Promise<RepositoryContext> {
	const [worktreeRoot, gitCommonDir] = await Promise.all([
		resolveGitPath(cwd, ['--show-toplevel']),
		resolveGitPath(cwd, ['--path-format=absolute', '--git-common-dir']),
	])

	return {
		worktreeRoot: await realpath(worktreeRoot),
		gitCommonDir: await realpath(gitCommonDir),
	}
}

async function resolveGitPath(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(['git', '-C', cwd, 'rev-parse', ...args], {
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

	return stdout.trim()
}

/**
 * Reset git-root cache for tests.
 *
 * Why: tests may stub process state and need deterministic isolation.
 */
export function _resetGitRootCache(): void {
	_gitRootPromise = null
	_repositoryContextPromise = null
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
	return (await resolvePathContextOrDefault(inputPath)).realPath
}

async function resolvePathContextOrDefault(
	inputPath?: string,
): Promise<PathContext> {
	const candidate =
		inputPath === undefined || inputPath.trim() === ''
			? process.cwd()
			: inputPath
	return resolvePathContext(candidate)
}

/**
 * Validate and canonicalize a path while enforcing repository boundaries.
 *
 * Why: defense-in-depth against traversal, control-byte injection, and symlink
 * escapes before any filesystem reads or command execution.
 */
export async function validatePath(inputPath: string): Promise<string> {
	return (await resolvePathContext(inputPath)).realPath
}

export async function resolvePathContext(
	inputPath: string,
	options?: { baseDir?: string },
): Promise<PathContext> {
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

	const resolvedPath = path.resolve(
		options?.baseDir ?? process.cwd(),
		inputPath,
	)
	let realInputPath: string
	let nearestExistingDir: string

	try {
		realInputPath = await realpath(resolvedPath)
		nearestExistingDir = (await stat(realInputPath)).isDirectory()
			? realInputPath
			: path.dirname(realInputPath)
	} catch (error) {
		const err = error as NodeJS.ErrnoException
		if (err.code === 'ENOENT') {
			const resolved = await resolveNearestAncestor(resolvedPath)
			realInputPath = resolved.realPath
			nearestExistingDir = resolved.nearestExistingDir
		} else {
			throw new Error(`Cannot resolve path: ${err.message}`)
		}
	}

	const startupContext = await getStartupRepositoryContext()
	if (isPathInsideOrEqual(realInputPath, startupContext.worktreeRoot)) {
		return {
			realPath: realInputPath,
			worktreeRoot: startupContext.worktreeRoot,
			startupRoot: startupContext.worktreeRoot,
			gitCommonDir: startupContext.gitCommonDir,
		}
	}

	let targetContext: RepositoryContext
	try {
		targetContext = await resolveRepositoryContext(nearestExistingDir)
	} catch {
		throw new Error(
			`Path outside configured runner repository or linked worktrees: ${inputPath}`,
		)
	}

	if (
		targetContext.gitCommonDir === startupContext.gitCommonDir &&
		isPathInsideOrEqual(realInputPath, targetContext.worktreeRoot)
	) {
		return {
			realPath: realInputPath,
			worktreeRoot: targetContext.worktreeRoot,
			startupRoot: startupContext.worktreeRoot,
			gitCommonDir: targetContext.gitCommonDir,
		}
	}

	throw new Error(
		`Path outside configured runner repository or linked worktrees: ${inputPath}`,
	)
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
async function resolveNearestAncestor(resolvedPath: string): Promise<{
	realPath: string
	nearestExistingDir: string
}> {
	let dir = path.dirname(resolvedPath)
	const suffix = path.basename(resolvedPath)
	const segments: string[] = [suffix]

	while (dir !== path.dirname(dir)) {
		try {
			const realDir = await realpath(dir)
			return {
				realPath: path.join(realDir, ...segments),
				nearestExistingDir: realDir,
			}
		} catch {
			segments.unshift(path.basename(dir))
			dir = path.dirname(dir)
		}
	}

	return {
		realPath: resolvedPath,
		nearestExistingDir: path.dirname(resolvedPath),
	}
}

function isPathInsideOrEqual(candidatePath: string, rootPath: string): boolean {
	const relative = path.relative(rootPath, candidatePath)
	return (
		relative === '' ||
		(relative.length > 0 &&
			!relative.startsWith('..') &&
			!path.isAbsolute(relative))
	)
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
 * Find nearest tsconfig/jsconfig bounded to a worktree root.
 *
 * Why: unbounded upward traversal can leak repository context and hit unrelated
 * configs outside the project boundary.
 */
export async function findNearestTsConfig(
	filePath: string,
	boundaryRoot?: string,
): Promise<{
	found: boolean
	configDir?: string
	configPath?: string
}> {
	const gitRoot = boundaryRoot ?? (await getGitRoot())
	let current = path.dirname(path.resolve(filePath))

	if (!isPathInsideOrEqual(current, gitRoot)) {
		return { found: false }
	}

	while (isPathInsideOrEqual(current, gitRoot)) {
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
	const pathContext = await resolvePathContextOrDefault(targetPath)
	const resolved = pathContext.realPath
	const boundaryRoot = pathContext.worktreeRoot

	if (!(await fileExists(resolved))) {
		throw new TscToolError(
			'PATH_NOT_FOUND',
			`Path not found: ${resolved}`,
			undefined,
			boundaryRoot,
		)
	}

	const fileStat = await stat(resolved)

	if (fileStat.isDirectory()) {
		for (const candidate of TSC_CONFIG_FILES) {
			const candidatePath = path.join(resolved, candidate)
			if (await fileExists(candidatePath)) {
				return { cwd: resolved, configPath: candidatePath }
			}
		}

		const nearest = await findNearestTsConfig(
			path.join(resolved, 'index.ts'),
			boundaryRoot,
		)
		if (nearest.found && nearest.configDir && nearest.configPath) {
			return { cwd: nearest.configDir, configPath: nearest.configPath }
		}

		throw new TscToolError(
			'CONFIG_NOT_FOUND',
			`No tsconfig.json or jsconfig.json found for directory ${resolved}`,
			undefined,
			boundaryRoot,
		)
	}

	const nearest = await findNearestTsConfig(resolved, boundaryRoot)
	if (nearest.found && nearest.configDir && nearest.configPath) {
		return { cwd: nearest.configDir, configPath: nearest.configPath }
	}

	throw new TscToolError(
		'CONFIG_NOT_FOUND',
		`No tsconfig.json or jsconfig.json found for file ${resolved}`,
		undefined,
		boundaryRoot,
	)
}

export async function spawnWithTimeout(
	cmd: string[],
	timeoutMs: number,
	options?: {
		cwd?: string
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
				undefined,
				options?.cwd,
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

	const maxBytes = options?.maxBytes ?? TSC_OUTPUT_CAPTURE_MAX_BYTES
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

async function runTsc(cwd: string, configPath: string): Promise<TscOutput> {
	const invocation = createTscInvocation(configPath)

	const {
		stdout,
		stderr,
		exitCode,
		timedOut,
		stdoutTruncated,
		stderrTruncated,
	} = await spawnWithTimeout(invocation.cmd, TSC_TIMEOUT_MS, {
		cwd,
		env: invocation.env,
	})

	if (timedOut) {
		throw new TscToolError(
			'TIMEOUT',
			`TypeScript check timed out after ${TSC_TIMEOUT_MS / 1000}s in ${cwd}.`,
			undefined,
			cwd,
		)
	}
	if (stdoutTruncated || stderrTruncated) {
		throw new TscToolError(
			'SPAWN_FAILURE',
			`TypeScript output exceeded ${TSC_OUTPUT_CAPTURE_MAX_BYTES} bytes in ${cwd}. Narrow scope or reduce compiler verbosity.`,
			undefined,
			cwd,
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
			undefined,
			cwd,
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
			cwd: error.cwd,
		}
	}

	const message = error instanceof Error ? error.message : String(error)
	return {
		code: 'SPAWN_FAILURE',
		message,
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
	const commonFile = getCommonTscFile(output.errors)
	if (commonFile) {
		lines.push(`File: ${commonFile}`)
		lines.push('')
	}
	for (const error of output.errors) {
		const location = commonFile
			? `${error.line}:${error.col}`
			: `${error.file}:${error.line}:${error.col}`
		lines.push(`- ${location} - ${error.message}`)
	}
	return lines.join('\n')
}

function getCommonTscFile(errors: TscError[]): string | null {
	if (errors.length === 0) {
		return null
	}
	const first = errors[0]?.file
	if (!first) {
		return null
	}
	return errors.every((error) => error.file === first) ? first : null
}

export function compactTscOutputForJsonText(
	output: TscOutput,
): Record<string, unknown> {
	const commonFile = getCommonTscFile(output.errors)
	if (!commonFile) {
		return stripNullishDeep(output) as unknown as Record<string, unknown>
	}

	return stripNullishDeep({
		cwd: output.cwd,
		configPath: output.configPath,
		timedOut: output.timedOut,
		exitCode: output.exitCode,
		errorCount: output.errorCount,
		parseWarning: output.parseWarning,
		rawStderr: output.rawStderr,
		remediationHint: output.remediationHint,
		commonFile,
		errors: output.errors.map((error) => ({
			line: error.line,
			col: error.col,
			code: error.code,
			message: error.message,
		})),
	})
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
			const finishRequest = startRequestActivity(options)
			try {
				observabilityState.clientMcpLogLevel = request.params.level
				toolLogger.info('Updated MCP logging level', {
					mcpLevel: request.params.level,
				})
				return {}
			} finally {
				finishRequest()
			}
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
			const finishRequest = startRequestActivity(options)
			try {
				return await withContext(
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
									? JSON.stringify(compactTscOutputForJsonText(output))
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
								structuredContent: toStructured(
									stripNullishDeep(output) as unknown as Record<
										string,
										unknown
									>,
								),
							}
						} catch (error) {
							const failure = toToolFailure(error)
							const failureOutput: TscOutput = {
								cwd: failure.cwd ?? process.cwd(),
								configPath: '',
								timedOut: failure.code === 'TIMEOUT',
								exitCode: 1,
								errors: [
									{
										file: '',
										line: 1,
										col: 1,
										code: failure.code,
										message: failure.message,
									},
								],
								errorCount: 1,
								remediationHint: failure.remediationHint,
								parseWarning:
									'Tool failed before compiler diagnostics could be produced.',
								rawStderr: failure.message,
							}
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
								structuredContent: toStructured(
									stripNullishDeep(failureOutput) as unknown as Record<
										string,
										unknown
									>,
								),
							}
						}
					},
				)
			} finally {
				finishRequest()
			}
		},
	)

	lifecycleLogger.info('tsc-runner server initialized', {
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
 * Default idle shutdown interval in milliseconds.
 */
export const DEFAULT_IDLE_EXIT_MS = 900_000

/**
 * Lower bound for the idle interval to prevent event-loop saturation.
 */
export const MIN_IDLE_EXIT_MS = 50

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
 * Parse the MCP_IDLE_EXIT_MS env value into an idle shutdown interval.
 *
 * Returns 0 to disable idle shutdown. Otherwise returns the clamped positive
 * interval. Unparseable / empty / NaN values fall back to the default.
 */
export function parseIdleExitMs(raw: string | undefined): number {
	if (raw === undefined) {
		return DEFAULT_IDLE_EXIT_MS
	}
	const trimmed = raw.trim()
	if (trimmed === '') {
		return DEFAULT_IDLE_EXIT_MS
	}
	const parsed = Number(trimmed)
	if (!Number.isFinite(parsed)) {
		return DEFAULT_IDLE_EXIT_MS
	}
	if (parsed <= 0) {
		return 0
	}
	return Math.max(parsed, MIN_IDLE_EXIT_MS)
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
 * Watch for inactivity and invoke onIdle when no tracked activity is in flight.
 *
 * This is a backstop for app-hosted clients that keep the parent process and
 * stdio pipes open after a session is abandoned. Tracked activity currently
 * covers tool calls and logging/setLevel requests.
 */
export function createIdleShutdownWatcher(opts: {
	idleMs: number
	onIdle: () => void
}):
	| {
			recordRequestStart: () => () => void
			stop: () => void
	  }
	| undefined {
	if (opts.idleMs <= 0) {
		return undefined
	}

	let activeRequests = 0
	let stopped = false
	let handle: ReturnType<typeof setTimeout> | undefined

	const clear = () => {
		if (handle) {
			clearTimeout(handle)
			handle = undefined
		}
	}

	const schedule = () => {
		clear()
		if (stopped || activeRequests > 0) {
			return
		}
		handle = setTimeout(() => {
			handle = undefined
			if (stopped || activeRequests > 0) {
				return
			}
			stopped = true
			opts.onIdle()
		}, opts.idleMs)
		handle.unref()
	}

	schedule()

	return {
		recordRequestStart: () => {
			if (stopped) {
				return () => {}
			}
			activeRequests += 1
			clear()
			let finished = false
			return () => {
				if (finished) {
					return
				}
				finished = true
				activeRequests = Math.max(0, activeRequests - 1)
				schedule()
			}
		},
		stop: () => {
			stopped = true
			clear()
		},
	}
}

interface IdleExitEnv {
	readonly [key: string]: string | undefined
	MCP_IDLE_EXIT_MS?: string | undefined
}

/**
 * Create idle shutdown wiring from process-style environment values.
 *
 * Why: startTscServer should exercise the same default-on / disabled parsing
 * as unit tests without making runtime smoke wait for the 15-minute default.
 */
export function createIdleShutdownWatcherFromEnv(opts: {
	env: IdleExitEnv
	onIdle: (idleMs: number) => void
	createWatcher?: typeof createIdleShutdownWatcher
}): {
	idleMs: number
	watcher: ReturnType<typeof createIdleShutdownWatcher>
} {
	const idleMs = parseIdleExitMs(opts.env.MCP_IDLE_EXIT_MS)
	const createWatcher = opts.createWatcher ?? createIdleShutdownWatcher
	return {
		idleMs,
		watcher: createWatcher({
			idleMs,
			onIdle: () => opts.onIdle(idleMs),
		}),
	}
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
 *
 * Why: explicit lifecycle wiring keeps shutdown reliable in CLI-hosted runs.
 */
export async function startTscServer(): Promise<void> {
	// Capture before any await: if the parent dies during async init,
	// process.ppid reparents to 1 and the original PID is lost.
	const initialPpid = process.ppid
	let idleWatcher: ReturnType<typeof createIdleShutdownWatcher> | undefined
	const server = await createTscServer({
		onRequestStart: () => idleWatcher?.recordRequestStart() ?? (() => {}),
	})
	const transport = new StdioServerTransport()
	let shuttingDown = false
	const lifecycleLogger = getLogger(['mcp', 'lifecycle'])

	const shutdown = async () => {
		if (shuttingDown) {
			return
		}
		shuttingDown = true
		idleWatcher?.stop()
		lifecycleLogger.info('Shutting down tsc-runner server')
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
			lifecycleLogger.error('Failed to close tsc-runner server cleanly', {
				error: error instanceof Error ? error.message : String(error),
			})
		} finally {
			process.exit(0)
		}
	}

	transport.onclose = () => {
		void shutdown()
	}

	const idleShutdown = createIdleShutdownWatcherFromEnv({
		env: process.env,
		onIdle: (idleMs) => {
			lifecycleLogger.info('Idle timeout reached, shutting down', {
				idleMs,
			})
			void shutdown()
		},
	})
	idleWatcher = idleShutdown.watcher

	await server.connect(transport)
	lifecycleLogger.info('tsc-runner server connected to stdio transport')
	process.stdin.resume()

	process.on('SIGINT', () => {
		void shutdown()
	})
	process.on('SIGTERM', () => {
		void shutdown()
	})

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
	void startTscServer()
}
