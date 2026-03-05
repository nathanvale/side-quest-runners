#!/usr/bin/env bun

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

type EvalOutput = {
	version: 1
	createdAt: string
	suite: string
	suiteVersion: string
	promptCount: number
	canaryPromptCount: number
	model: string
	repeats: number
	temperature: number
	dryRun: boolean
	usage: {
		evaluationCount: number
		totalTokens: number
	}
	metrics: {
		byVariant: {
			'before-uplift': {
				firstChoiceAccuracy: number
				meanExtraCalls: number
			}
			'after-uplift': {
				firstChoiceAccuracy: number
				meanExtraCalls: number
			}
		}
		delta: {
			firstChoiceAccuracy: number
			meanExtraCalls: number
		}
	}
}

type TrendRow = {
	timestamp: string
	suite: string
	suiteVersion: string
	model: string
	repeats: string
	promptCount: string
	canaryPromptCount: string
	evaluationCount: string
	totalTokens: string
	beforeAccuracy: string
	afterAccuracy: string
	deltaAccuracy: string
	beforeMeanExtraCalls: string
	afterMeanExtraCalls: string
	deltaMeanExtraCalls: string
	thresholdStatus: string
	failed: string
	alertStreak: string
	dryRun: string
}

const CSV_HEADER = [
	'timestamp',
	'suite',
	'suite_version',
	'model',
	'repeats',
	'prompt_count',
	'canary_prompt_count',
	'evaluation_count',
	'total_tokens',
	'before_accuracy',
	'after_accuracy',
	'delta_accuracy',
	'before_mean_extra_calls',
	'after_mean_extra_calls',
	'delta_mean_extra_calls',
	'threshold_status',
	'failed',
	'alert_streak',
	'dry_run',
] as const

function parseArg(name: string, fallback: string): string {
	const exact = Bun.argv.find((arg) => arg.startsWith(`${name}=`))
	if (!exact) {
		return fallback
	}
	return exact.slice(name.length + 1)
}

function parseBoolArg(name: string): boolean {
	const value = parseArg(name, '')
	return value === '1' || value === 'true' || value === 'yes'
}

function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true })
	}
}

function toFixed(value: number, decimals = 6): string {
	return value.toFixed(decimals)
}

function csvCell(raw: string): string {
	const withFormulaGuard = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
	const escaped = withFormulaGuard.replaceAll('"', '""')
	return `"${escaped}"`
}

function encodeRow(row: TrendRow): string {
	return [
		row.timestamp,
		row.suite,
		row.suiteVersion,
		row.model,
		row.repeats,
		row.promptCount,
		row.canaryPromptCount,
		row.evaluationCount,
		row.totalTokens,
		row.beforeAccuracy,
		row.afterAccuracy,
		row.deltaAccuracy,
		row.beforeMeanExtraCalls,
		row.afterMeanExtraCalls,
		row.deltaMeanExtraCalls,
		row.thresholdStatus,
		row.failed,
		row.alertStreak,
		row.dryRun,
	]
		.map(csvCell)
		.join(',')
}

async function atomicWrite(targetPath: string, content: string): Promise<void> {
	const dir = dirname(targetPath)
	ensureDir(dir)
	const tmpPath = join(dir, `.${basename(targetPath)}.tmp.${process.pid}`)
	try {
		await Bun.write(tmpPath, content)
		renameSync(tmpPath, targetPath)
	} catch (error) {
		try {
			unlinkSync(tmpPath)
		} catch {
			// Ignore cleanup failure.
		}
		throw error
	}
}

function buildLatestMarkdown(
	input: EvalOutput,
	csvPath: string,
	archivePath: string,
): string {
	const before = input.metrics.byVariant['before-uplift']
	const after = input.metrics.byVariant['after-uplift']
	const delta = input.metrics.delta
	const statusLine = input.dryRun
		? 'Status: dry-run (no API calls executed).'
		: 'Status: threshold evaluation pending.'

	return [
		'# Discoverability AB Latest',
		'',
		`- Timestamp: ${input.createdAt}`,
		`- Suite: ${input.suite} (${input.suiteVersion})`,
		`- Model: ${input.model}`,
		`- Repeats: ${input.repeats}`,
		`- Prompt count: ${input.promptCount} (${input.canaryPromptCount} canary)`,
		`- Usage: ${input.usage.evaluationCount} evaluations, ${input.usage.totalTokens} tokens`,
		`- ${statusLine}`,
		'',
		'## Metrics',
		'',
		`- Before first-choice accuracy: ${toFixed(before.firstChoiceAccuracy, 4)}`,
		`- After first-choice accuracy: ${toFixed(after.firstChoiceAccuracy, 4)}`,
		`- Delta first-choice accuracy: ${toFixed(delta.firstChoiceAccuracy, 4)}`,
		`- Before mean extra calls: ${toFixed(before.meanExtraCalls, 4)}`,
		`- After mean extra calls: ${toFixed(after.meanExtraCalls, 4)}`,
		`- Delta mean extra calls: ${toFixed(delta.meanExtraCalls, 4)}`,
		'',
		'## Artifacts',
		'',
		`- Trend CSV: \`${csvPath}\``,
		`- Archive JSON: \`${archivePath}\``,
	].join('\n')
}

async function main(): Promise<void> {
	const inPath = parseArg('--in', '')
	if (!inPath) {
		throw new Error('--in is required')
	}

	const csvPath = parseArg('--csv', 'reports/ab/trend.csv')
	const latestPath = parseArg('--latest', 'reports/ab/latest.md')
	const archiveDir = parseArg('--archive-dir', 'reports/ab/archive')
	const forceTimestamp = parseArg('--timestamp', '')
	const markDryRun = parseBoolArg('--dry-run')

	const input = JSON.parse(readFileSync(inPath, 'utf8')) as EvalOutput
	const timestamp = forceTimestamp || input.createdAt
	const archiveFile = `${timestamp.replaceAll(':', '-').replaceAll('.', '-')}.json`
	const archivePath = join(archiveDir, archiveFile)

	const row: TrendRow = {
		timestamp,
		suite: input.suite,
		suiteVersion: input.suiteVersion,
		model: input.model,
		repeats: `${input.repeats}`,
		promptCount: `${input.promptCount}`,
		canaryPromptCount: `${input.canaryPromptCount}`,
		evaluationCount: `${input.usage.evaluationCount}`,
		totalTokens: `${input.usage.totalTokens}`,
		beforeAccuracy: toFixed(
			input.metrics.byVariant['before-uplift'].firstChoiceAccuracy,
		),
		afterAccuracy: toFixed(
			input.metrics.byVariant['after-uplift'].firstChoiceAccuracy,
		),
		deltaAccuracy: toFixed(input.metrics.delta.firstChoiceAccuracy),
		beforeMeanExtraCalls: toFixed(
			input.metrics.byVariant['before-uplift'].meanExtraCalls,
		),
		afterMeanExtraCalls: toFixed(
			input.metrics.byVariant['after-uplift'].meanExtraCalls,
		),
		deltaMeanExtraCalls: toFixed(input.metrics.delta.meanExtraCalls),
		thresholdStatus: markDryRun || input.dryRun ? 'dry_run' : 'pending',
		failed: 'false',
		alertStreak: '0',
		dryRun: String(markDryRun || input.dryRun),
	}

	const existing = existsSync(csvPath)
		? readFileSync(csvPath, 'utf8').trimEnd()
		: ''
	const lines = existing ? existing.split('\n') : []
	const hasHeader = lines[0] === CSV_HEADER.join(',')
	const nextLines = [
		...(hasHeader ? lines : [CSV_HEADER.join(','), ...lines.filter(Boolean)]),
		encodeRow(row),
	]

	await atomicWrite(csvPath, `${nextLines.join('\n')}\n`)
	await atomicWrite(
		latestPath,
		`${buildLatestMarkdown(input, csvPath, archivePath)}\n`,
	)

	ensureDir(archiveDir)
	await atomicWrite(archivePath, `${JSON.stringify(input, null, 2)}\n`)

	console.log(
		JSON.stringify(
			{
				csvPath,
				latestPath,
				archivePath,
				timestamp,
				suite: input.suite,
				suiteVersion: input.suiteVersion,
			},
			null,
			2,
		),
	)
}

await main()
