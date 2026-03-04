#!/usr/bin/env bun

/// <reference types="bun-types" />

import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const TSC_CONFIG_FILES = ['tsconfig.json', 'jsconfig.json'] as const
const TSC_TIMEOUT_MS = 30_000

const tscOutputSchema = z.object({
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

type TscOutput = z.infer<typeof tscOutputSchema>

function parseTscOutput(
	output: string,
): Pick<TscOutput, 'errors' | 'errorCount'> {
	const errors: TscOutput['errors'] = []
	const errorPattern = /^(.+?)\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/gm

	for (const match of output.matchAll(errorPattern)) {
		const [, file, line, col, message] = match
		if (!file || !line || !col || !message) {
			continue
		}

		errors.push({
			file,
			line: Number.parseInt(line, 10),
			col: Number.parseInt(col, 10),
			message,
		})
	}

	return { errors, errorCount: errors.length }
}

async function findNearestTsConfig(filePath: string): Promise<{
	found: boolean
	configDir?: string
	configPath?: string
}> {
	let current = path.dirname(filePath)

	while (true) {
		for (const configFile of TSC_CONFIG_FILES) {
			const candidatePath = path.join(current, configFile)
			if (fs.existsSync(candidatePath)) {
				return {
					found: true,
					configDir: current,
					configPath: candidatePath,
				}
			}
		}

		const parent = path.dirname(current)
		if (parent === current) {
			return { found: false }
		}
		current = parent
	}
}

async function resolveWorkdir(targetPath?: string): Promise<{
	cwd: string
	configPath: string
}> {
	const resolved = targetPath ? path.resolve(targetPath) : process.cwd()

	if (!fs.existsSync(resolved)) {
		throw new Error(`Path not found: ${resolved}`)
	}

	const stat = fs.statSync(resolved)

	if (stat.isDirectory()) {
		for (const candidate of TSC_CONFIG_FILES) {
			const candidatePath = path.join(resolved, candidate)
			if (fs.existsSync(candidatePath)) {
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
	const timeout = setTimeout(() => {
		timedOut = true
		proc.kill('SIGTERM')
	}, timeoutMs)

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])

	clearTimeout(timeout)

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
 * Create a raw SDK MCP server for the Phase 0 architecture PoC.
 *
 * Why: keeps server construction testable so `InMemoryTransport` can validate
 * tool metadata and `structuredContent` behavior without stdio wiring.
 */
export function createRawSdkTscServer(): McpServer {
	const server = new McpServer({
		name: 'tsc-runner',
		version: '1.0.2',
	})

	server.registerTool(
		'tsc_check',
		{
			title: 'TypeScript Type Checker',
			description:
				'Run TypeScript type checking (tsc --noEmit) for a file or directory and return structured diagnostics.',
			inputSchema: z.object({
				path: z
					.string()
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
			const { cwd, configPath } = await resolveWorkdir(args.path)
			const output = await runTsc(cwd, configPath)
			const format = args.response_format ?? 'json'
			const text =
				format === 'json'
					? JSON.stringify(output)
					: output.exitCode === 0 || output.errorCount === 0
						? `TypeScript passed (cwd: ${output.cwd})`
						: `${output.errorCount} type error(s) (cwd: ${output.cwd})\nConfig: ${output.configPath}`

			return {
				isError: false,
				content: [{ type: 'text', text }],
				structuredContent: output,
			}
		},
	)

	return server
}

/**
 * Start the Phase 0 PoC server over stdio with explicit lifecycle handling.
 *
 * Why: mirrors production MCP process behavior (`stdin.resume`, `onclose`,
 * signal shutdown) so the PoC proves integration details, not just compilation.
 */
export async function startRawSdkPocServer(): Promise<void> {
	const server = createRawSdkTscServer()
	const transport = new StdioServerTransport()

	transport.onclose = () => {
		process.exit(0)
	}

	await server.connect(transport)
	process.stdin.resume()

	const shutdown = async () => {
		await server.close()
		process.exit(0)
	}

	process.on('SIGINT', () => {
		void shutdown()
	})

	process.on('SIGTERM', () => {
		void shutdown()
	})
}

if (import.meta.main) {
	void startRawSdkPocServer()
}
