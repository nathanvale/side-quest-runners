#!/usr/bin/env bun

/// <reference types="bun-types" />

/**
 * TypeScript checker MCP server.
 *
 * Runs `bunx tsc --noEmit --pretty false` from the nearest tsconfig/jsconfig
 * and reports errors in a Claude-friendly format.
 */

import { access, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
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

export interface TscError {
	file: string
	line: number
	col: number
	message: string
}

export interface TscOutput {
	cwd: string
	configPath: string
	timedOut: boolean
	exitCode: number
	errors: TscError[]
	errorCount: number
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
			message: z.string(),
		}),
	),
	errorCount: z.number(),
})

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

	const errorPattern = /^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/gm
	const matches = output.matchAll(errorPattern)

	for (const match of matches) {
		const [, file, line, col, message] = match
		if (file && line && col && message) {
			errors.push({
				file,
				line: Number.parseInt(line, 10),
				col: Number.parseInt(col, 10),
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
		throw new Error(`Path not found: ${resolved}`)
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

		throw new Error(
			`No tsconfig.json or jsconfig.json found for directory ${resolved}`,
		)
	}

	const nearest = await findNearestTsConfig(resolved)
	if (nearest.found && nearest.configDir && nearest.configPath) {
		return { cwd: nearest.configDir, configPath: nearest.configPath }
	}

	throw new Error(
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
	const proc = Bun.spawn(cmd, {
		cwd: options?.cwd,
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

async function runTsc(cwd: string, configPath: string): Promise<TscOutput> {
	const { stdout, stderr, exitCode, timedOut } = await spawnWithTimeout(
		['bunx', 'tsc', '--noEmit', '--pretty', 'false'],
		TSC_TIMEOUT_MS,
		{
			cwd,
			env: { ...process.env, CI: 'true' },
		},
	)

	const parsed = parseTscOutput(`${stdout}${stderr}`)
	return {
		cwd,
		configPath,
		timedOut,
		exitCode,
		errors: parsed.errors,
		errorCount: parsed.errorCount,
	}
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
export function createTscServer(): McpServer {
	const server = new McpServer({
		name: 'tsc-runner',
		version: '1.0.2',
	})

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
		async (args): Promise<CallToolResult> => {
			try {
				const { cwd, configPath } = await resolveWorkdir(args.path)
				const output = await runTsc(cwd, configPath)
				const format = args.response_format ?? 'json'

				const text =
					format === 'json'
						? JSON.stringify(output)
						: output.timedOut
							? `TypeScript check timed out after ${TSC_TIMEOUT_MS / 1000}s in ${output.cwd}.`
							: output.exitCode === 0 || output.errorCount === 0
								? `TypeScript passed (cwd: ${output.cwd})`
								: formatTscMarkdown(output)

				return {
					isError: false,
					content: [{ type: 'text', text }],
					structuredContent: toStructured(output),
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
 *
 * Why: explicit lifecycle wiring keeps shutdown reliable in CLI-hosted runs.
 */
export async function startTscServer(): Promise<void> {
	const server = createTscServer()
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

if (import.meta.main) {
	void startTscServer()
}
