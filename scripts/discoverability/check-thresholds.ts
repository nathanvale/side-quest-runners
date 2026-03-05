#!/usr/bin/env bun

import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const ROLLING_WINDOW = 10
const MIN_BASELINE_RUNS = 5
const SIGMA_THRESHOLD = 2
const ABSOLUTE_ACCURACY_FLOOR = 0.02
const ABSOLUTE_MEAN_EXTRA_FLOOR = 0.02
const REQUIRED_CONSECUTIVE_FAILS = 2

type TrendRecord = {
	values: string[]
	index: number
	timestamp: string
	suite: string
	suiteVersion: string
	beforeAccuracy: number
	afterAccuracy: number
	beforeMeanExtraCalls: number
	afterMeanExtraCalls: number
	thresholdStatus: string
	failed: boolean
	alertStreak: number
	dryRun: boolean
}

type ThresholdResult = {
	status:
		| 'pass'
		| 'fail'
		| 'insufficient_baseline'
		| 'dry_run'
		| 'forced_baseline'
	shouldAlert: boolean
	shouldCloseAlert: boolean
	failed: boolean
	alertStreak: number
	reason: string
	baselineRunCount: number
	suiteVersion: string
	timestamp: string
	thresholds: {
		sigma: number
		minBaselineRuns: number
		requiredConsecutiveFails: number
		absoluteAccuracyFloor: number
		absoluteMeanExtraFloor: number
	}
	comparisons: {
		accuracy: {
			current: number
			mean: number
			stddev: number
			limit: number
			failed: boolean
		}
		meanExtraCalls: {
			current: number
			mean: number
			stddev: number
			limit: number
			failed: boolean
		}
	}
}

const CSV_KEYS = {
	timestamp: 'timestamp',
	suite: 'suite',
	suiteVersion: 'suite_version',
	beforeAccuracy: 'before_accuracy',
	afterAccuracy: 'after_accuracy',
	beforeMeanExtraCalls: 'before_mean_extra_calls',
	afterMeanExtraCalls: 'after_mean_extra_calls',
	thresholdStatus: 'threshold_status',
	failed: 'failed',
	alertStreak: 'alert_streak',
	dryRun: 'dry_run',
} as const

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

function mean(values: readonly number[]): number {
	if (values.length === 0) {
		return 0
	}
	return values.reduce((acc, value) => acc + value, 0) / values.length
}

function stddev(values: readonly number[]): number {
	if (values.length < 2) {
		return 0
	}
	const avg = mean(values)
	const variance =
		values.reduce((acc, value) => acc + (value - avg) ** 2, 0) / values.length
	return Math.sqrt(variance)
}

function parseCsvLine(line: string): string[] {
	const cells: string[] = []
	let current = ''
	let inQuotes = false
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i]
		if (char === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"'
				i += 1
				continue
			}
			inQuotes = !inQuotes
			continue
		}
		if (char === ',' && !inQuotes) {
			cells.push(current)
			current = ''
			continue
		}
		current += char
	}
	cells.push(current)
	return cells
}

function encodeCsvLine(values: readonly string[]): string {
	return values.map((value) => `"${value.replaceAll('"', '""')}"`).join(',')
}

function readRecords(csvPath: string): {
	header: string[]
	records: TrendRecord[]
} {
	if (!existsSync(csvPath)) {
		throw new Error(`CSV file not found: ${csvPath}`)
	}

	const lines = readFileSync(csvPath, 'utf8').trim().split('\n').filter(Boolean)

	if (lines.length < 2) {
		throw new Error(`CSV file has no data rows: ${csvPath}`)
	}

	const header = parseCsvLine(lines[0] ?? '')
	const headerMap = new Map(header.map((key, index) => [key, index]))

	const required = Object.values(CSV_KEYS)
	for (const key of required) {
		if (!headerMap.has(key)) {
			throw new Error(`CSV header missing required column: ${key}`)
		}
	}

	const records = lines.slice(1).map((line, index) => {
		const values = parseCsvLine(line)
		const get = (key: string) => values[headerMap.get(key) ?? -1] ?? ''
		const parseNum = (value: string) => {
			const parsed = Number.parseFloat(value)
			return Number.isFinite(parsed) ? parsed : 0
		}
		return {
			values,
			index,
			timestamp: get(CSV_KEYS.timestamp),
			suite: get(CSV_KEYS.suite),
			suiteVersion: get(CSV_KEYS.suiteVersion),
			beforeAccuracy: parseNum(get(CSV_KEYS.beforeAccuracy)),
			afterAccuracy: parseNum(get(CSV_KEYS.afterAccuracy)),
			beforeMeanExtraCalls: parseNum(get(CSV_KEYS.beforeMeanExtraCalls)),
			afterMeanExtraCalls: parseNum(get(CSV_KEYS.afterMeanExtraCalls)),
			thresholdStatus: get(CSV_KEYS.thresholdStatus),
			failed: get(CSV_KEYS.failed) === 'true',
			alertStreak: Number.parseInt(get(CSV_KEYS.alertStreak), 10) || 0,
			dryRun: get(CSV_KEYS.dryRun) === 'true',
		} satisfies TrendRecord
	})

	return { header, records }
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const dir = dirname(path)
	const tmpPath = join(dir, `.${basename(path)}.tmp.${process.pid}`)
	try {
		await Bun.write(tmpPath, content)
		renameSync(tmpPath, path)
	} catch (error) {
		try {
			unlinkSync(tmpPath)
		} catch {
			// Ignore cleanup failure.
		}
		throw error
	}
}

function limitFrom(
	meanValue: number,
	stdValue: number,
	absoluteFloor: number,
): number {
	const varianceBand = SIGMA_THRESHOLD * stdValue
	const margin = Math.max(absoluteFloor, varianceBand)
	return margin + meanValue
}

function evaluate(
	records: TrendRecord[],
	forceBaseline: boolean,
): ThresholdResult {
	const current = records.at(-1)
	if (!current) {
		throw new Error('No rows found in trend data.')
	}

	if (current.dryRun) {
		return {
			status: 'dry_run',
			shouldAlert: false,
			shouldCloseAlert: false,
			failed: false,
			alertStreak: 0,
			reason: 'Dry-run mode does not evaluate thresholds.',
			baselineRunCount: 0,
			suiteVersion: current.suiteVersion,
			timestamp: current.timestamp,
			thresholds: {
				sigma: SIGMA_THRESHOLD,
				minBaselineRuns: MIN_BASELINE_RUNS,
				requiredConsecutiveFails: REQUIRED_CONSECUTIVE_FAILS,
				absoluteAccuracyFloor: ABSOLUTE_ACCURACY_FLOOR,
				absoluteMeanExtraFloor: ABSOLUTE_MEAN_EXTRA_FLOOR,
			},
			comparisons: {
				accuracy: {
					current: current.afterAccuracy,
					mean: 0,
					stddev: 0,
					limit: 0,
					failed: false,
				},
				meanExtraCalls: {
					current: current.afterMeanExtraCalls,
					mean: 0,
					stddev: 0,
					limit: 0,
					failed: false,
				},
			},
		}
	}

	const sameVersion = records.filter(
		(record) => record.suiteVersion === current.suiteVersion,
	)
	const previousSameVersion = sameVersion.slice(0, -1)
	const baselineRows = previousSameVersion.slice(-ROLLING_WINDOW)

	if (forceBaseline) {
		return {
			status: 'forced_baseline',
			shouldAlert: false,
			shouldCloseAlert: false,
			failed: false,
			alertStreak: 0,
			reason:
				'force_baseline=true requested; threshold alerting skipped for this run.',
			baselineRunCount: baselineRows.length,
			suiteVersion: current.suiteVersion,
			timestamp: current.timestamp,
			thresholds: {
				sigma: SIGMA_THRESHOLD,
				minBaselineRuns: MIN_BASELINE_RUNS,
				requiredConsecutiveFails: REQUIRED_CONSECUTIVE_FAILS,
				absoluteAccuracyFloor: ABSOLUTE_ACCURACY_FLOOR,
				absoluteMeanExtraFloor: ABSOLUTE_MEAN_EXTRA_FLOOR,
			},
			comparisons: {
				accuracy: {
					current: current.afterAccuracy,
					mean: 0,
					stddev: 0,
					limit: 0,
					failed: false,
				},
				meanExtraCalls: {
					current: current.afterMeanExtraCalls,
					mean: 0,
					stddev: 0,
					limit: 0,
					failed: false,
				},
			},
		}
	}

	if (baselineRows.length < MIN_BASELINE_RUNS) {
		return {
			status: 'insufficient_baseline',
			shouldAlert: false,
			shouldCloseAlert: false,
			failed: false,
			alertStreak: 0,
			reason: `Need at least ${MIN_BASELINE_RUNS} prior runs; found ${baselineRows.length}.`,
			baselineRunCount: baselineRows.length,
			suiteVersion: current.suiteVersion,
			timestamp: current.timestamp,
			thresholds: {
				sigma: SIGMA_THRESHOLD,
				minBaselineRuns: MIN_BASELINE_RUNS,
				requiredConsecutiveFails: REQUIRED_CONSECUTIVE_FAILS,
				absoluteAccuracyFloor: ABSOLUTE_ACCURACY_FLOOR,
				absoluteMeanExtraFloor: ABSOLUTE_MEAN_EXTRA_FLOOR,
			},
			comparisons: {
				accuracy: {
					current: current.afterAccuracy,
					mean: 0,
					stddev: 0,
					limit: 0,
					failed: false,
				},
				meanExtraCalls: {
					current: current.afterMeanExtraCalls,
					mean: 0,
					stddev: 0,
					limit: 0,
					failed: false,
				},
			},
		}
	}

	const accuracyValues = baselineRows.map((row) => row.afterAccuracy)
	const meanExtraValues = baselineRows.map((row) => row.afterMeanExtraCalls)

	const accuracyMean = mean(accuracyValues)
	const accuracyStd = stddev(accuracyValues)
	const meanExtraMean = mean(meanExtraValues)
	const meanExtraStd = stddev(meanExtraValues)

	const accuracyLowerLimit = Math.max(
		0,
		accuracyMean -
			Math.max(ABSOLUTE_ACCURACY_FLOOR, SIGMA_THRESHOLD * accuracyStd),
	)
	const meanExtraUpperLimit = limitFrom(
		meanExtraMean,
		meanExtraStd,
		ABSOLUTE_MEAN_EXTRA_FLOOR,
	)

	const accuracyFailed = current.afterAccuracy < accuracyLowerLimit
	const meanExtraFailed = current.afterMeanExtraCalls > meanExtraUpperLimit
	const failed = accuracyFailed || meanExtraFailed

	const previous = sameVersion.at(-2)
	const previousStreak = previous?.failed ? previous.alertStreak : 0
	const alertStreak = failed ? previousStreak + 1 : 0
	const shouldAlert = failed && alertStreak >= REQUIRED_CONSECUTIVE_FAILS
	const shouldCloseAlert = !failed && (previous?.failed ?? false)

	return {
		status: failed ? 'fail' : 'pass',
		shouldAlert,
		shouldCloseAlert,
		failed,
		alertStreak,
		reason: failed
			? 'Current run is outside rolling baseline threshold.'
			: 'Current run is within rolling baseline threshold.',
		baselineRunCount: baselineRows.length,
		suiteVersion: current.suiteVersion,
		timestamp: current.timestamp,
		thresholds: {
			sigma: SIGMA_THRESHOLD,
			minBaselineRuns: MIN_BASELINE_RUNS,
			requiredConsecutiveFails: REQUIRED_CONSECUTIVE_FAILS,
			absoluteAccuracyFloor: ABSOLUTE_ACCURACY_FLOOR,
			absoluteMeanExtraFloor: ABSOLUTE_MEAN_EXTRA_FLOOR,
		},
		comparisons: {
			accuracy: {
				current: current.afterAccuracy,
				mean: accuracyMean,
				stddev: accuracyStd,
				limit: accuracyLowerLimit,
				failed: accuracyFailed,
			},
			meanExtraCalls: {
				current: current.afterMeanExtraCalls,
				mean: meanExtraMean,
				stddev: meanExtraStd,
				limit: meanExtraUpperLimit,
				failed: meanExtraFailed,
			},
		},
	}
}

function updateLastRow(
	header: string[],
	records: TrendRecord[],
	result: ThresholdResult,
): string {
	const headerMap = new Map(header.map((key, index) => [key, index]))
	const last = records.at(-1)
	if (!last) {
		throw new Error('No record to update.')
	}

	const values = [...last.values]
	values[headerMap.get(CSV_KEYS.thresholdStatus) ?? -1] = result.status
	values[headerMap.get(CSV_KEYS.failed) ?? -1] = String(result.failed)
	values[headerMap.get(CSV_KEYS.alertStreak) ?? -1] = `${result.alertStreak}`

	const rows = records.map((record) => record.values)
	rows[rows.length - 1] = values

	const encodedRows = rows.map((row) => encodeCsvLine(row))
	return `${[header.join(','), ...encodedRows].join('\n')}\n`
}

async function main(): Promise<void> {
	const csvPath = parseArg('--csv', 'reports/ab/trend.csv')
	const outPath = parseArg('--out', 'reports/ab/thresholds.json')
	const forceBaseline = parseBoolArg('--force-baseline')

	const { header, records } = readRecords(csvPath)
	const result = evaluate(records, forceBaseline)
	const nextCsv = updateLastRow(header, records, result)

	await atomicWrite(csvPath, nextCsv)
	await Bun.write(outPath, `${JSON.stringify(result, null, 2)}\n`)
	console.log(JSON.stringify(result, null, 2))

	if (result.status === 'fail') {
		process.exitCode = 1
	}
}

await main()
