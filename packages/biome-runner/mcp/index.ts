#!/usr/bin/env bun

/// <reference types="bun-types" />

/**
 * Biome Linter & Formatter MCP Server
 *
 * Provides tools to run Biome linting and formatting with structured output.
 */

import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * Bridge Zod-inferred output types to the SDK's Record<string, unknown>.
 *
 * Why: CallToolResult.structuredContent is typed as Record<string, unknown>),
 * but our Zod-inferred types (LintSummary, etc.) have concrete keys that
 * TypeScript considers structurally incompatible. This helper centralizes
 * the unavoidable cast so tool handlers stay clean.
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
	suggestion: string | null
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

const lintDiagnosticSchema = z.object({
	file: z.string(),
	message: z.string(),
	code: z.string(),
	line: z.number(),
	severity: z.enum(['error', 'warning', 'info']),
	suggestion: z.string().nullable(),
})

const lintSummarySchema = z.object({
	errorCount: z.number(),
	warningCount: z.number(),
	diagnostics: z.array(lintDiagnosticSchema),
})

const lintFixSchema = z.object({
	fixed: z.number(),
	formatFixed: z.number(),
	lintFixed: z.number(),
	remaining: lintSummarySchema,
})

const formatCheckSchema = z.object({
	formatted: z.boolean(),
	unformattedFiles: z.array(z.string()),
})

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

async function spawnWithTimeout(
	cmd: string[],
	options?: {
		cwd?: string
		env?: Record<string, string>
		timeoutMs?: number
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
	}, options?.timeoutMs ?? BIOME_TIMEOUT_MS)

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])

	clearTimeout(timeout)
	if (killTimer) clearTimeout(killTimer)
	return { stdout, stderr, exitCode, timedOut }
}

async function runBiomeCheck(inputPath = '.'): Promise<LintSummary> {
	const { stdout, stderr, timedOut } = await spawnWithTimeout(
		['bunx', '@biomejs/biome', 'check', '--reporter=json', inputPath],
		{ timeoutMs: BIOME_TIMEOUT_MS },
	)

	if (timedOut) {
		return {
			errorCount: 1,
			warningCount: 0,
			diagnostics: [
				{
					file: 'timeout',
					line: 0,
					message: `Biome check timed out after ${BIOME_TIMEOUT_MS / 1000}s`,
					code: 'timeout',
					severity: 'error',
					suggestion: null,
				},
			],
		}
	}

	return parseBiomeOutput(stdout || stderr)
}

async function runBiomeFix(
	inputPath = '.',
): Promise<z.infer<typeof lintFixSchema>> {
	// Snapshot diagnostics before fix so we can diff by category.
	const before = await runBiomeCheck(inputPath)

	// biome check --write applies both formatting and lint fixes in one pass,
	// so a separate biome format --write step is unnecessary.
	const fix = await spawnWithTimeout(
		[
			'bunx',
			'@biomejs/biome',
			'check',
			'--write',
			'--reporter=json',
			inputPath,
		],
		{ timeoutMs: BIOME_TIMEOUT_MS },
	)

	if (fix.timedOut) {
		throw new Error(
			`Biome check --write timed out after ${BIOME_TIMEOUT_MS / 1000}s`,
		)
	}

	const remaining = await runBiomeCheck(inputPath)

	// Derive fix counts by diffing before/after diagnostics by category.
	// Lint diagnostics use 'lint/<group>/<ruleName>' (e.g. 'lint/suspicious/noDoubleEquals').
	// Format issues don't carry a 'format/' prefix -- they are the remaining
	// resolved diagnostics not categorised as lint.
	const totalBefore = before.diagnostics.length
	const totalAfter = remaining.diagnostics.length
	const lintBefore = before.diagnostics.filter((d) =>
		d.code.startsWith('lint/'),
	).length
	const lintAfter = remaining.diagnostics.filter((d) =>
		d.code.startsWith('lint/'),
	).length

	const lintFixed = Math.max(0, lintBefore - lintAfter)
	const formatFixed = Math.max(0, totalBefore - totalAfter - lintFixed)

	return {
		fixed: formatFixed + lintFixed,
		formatFixed,
		lintFixed,
		remaining,
	}
}

async function runBiomeFormatCheck(
	inputPath = '.',
): Promise<z.infer<typeof formatCheckSchema>> {
	const { stdout, exitCode, timedOut } = await spawnWithTimeout(
		['bunx', '@biomejs/biome', 'format', '--reporter=json', inputPath],
		{ timeoutMs: BIOME_TIMEOUT_MS },
	)

	if (timedOut) {
		throw new Error(
			`Biome format check timed out after ${BIOME_TIMEOUT_MS / 1000}s`,
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
		return JSON.stringify(summary)
	}

	if (summary.errorCount === 0 && summary.warningCount === 0) {
		return 'No linting issues found.'
	}

	let output = `Found ${summary.errorCount} errors and ${summary.warningCount} warnings:\n\n`

	for (const diagnostic of summary.diagnostics) {
		const icon = diagnostic.severity === 'error' ? '[error]' : '[warn]'
		output += `${icon} ${diagnostic.file}:${diagnostic.line} [${diagnostic.code}]\n`
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
		return JSON.stringify(result)
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
	for (const diagnostic of result.remaining.diagnostics) {
		const icon = diagnostic.severity === 'error' ? '[error]' : '[warn]'
		output += `${icon} ${diagnostic.file}:${diagnostic.line} [${diagnostic.code}]\n`
		output += `   ${diagnostic.message}\n\n`
	}

	return output.trim()
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
export function createBiomeServer(): McpServer {
	const server = new McpServer({
		name: 'biome-runner',
		version: '1.0.2',
	})

	server.registerTool(
		'biome_lintCheck',
		{
			title: 'Biome Lint Checker',
			description:
				'Run Biome lint checks (both lint rules and formatting) on a file or directory. Returns error/warning counts and structured diagnostics. Read-only. Does not write fixes. Use biome_lintFix to apply fixes.',
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
		async (args): Promise<CallToolResult> => {
			try {
				const validatedPath = await validatePathOrDefault(args.path)
				const summary = await runBiomeCheck(validatedPath)
				const format = args.response_format ?? 'json'
				return {
					isError: false,
					content: [{ type: 'text', text: formatLintSummary(summary, format) }],
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
		'biome_lintFix',
		{
			title: 'Biome Lint Fixer',
			description:
				'Run Biome format/check with --write to auto-fix issues. Returns fixed counts and remaining diagnostics. Writes files. Use biome_lintCheck for read-only inspection.',
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
		async (args): Promise<CallToolResult> => {
			try {
				const validatedPath = await validatePathOrDefault(args.path)
				const result = await runBiomeFix(validatedPath)
				const format = args.response_format ?? 'json'
				return {
					isError: false,
					content: [
						{ type: 'text', text: formatLintFixResult(result, format) },
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

	server.registerTool(
		'biome_formatCheck',
		{
			title: 'Biome Format Checker',
			description:
				'Check whether files are formatted with Biome without writing changes. Returns formatted status and unformatted files. Read-only. Use biome_lintFix to apply formatting.',
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
		async (args): Promise<CallToolResult> => {
			try {
				const validatedPath = await validatePathOrDefault(args.path)
				const result = await runBiomeFormatCheck(validatedPath)
				const format = args.response_format ?? 'json'
				return {
					isError: false,
					content: [
						{ type: 'text', text: formatFormatCheckResult(result, format) },
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
export async function startBiomeServer(): Promise<void> {
	const server = createBiomeServer()
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
	void startBiomeServer()
}
