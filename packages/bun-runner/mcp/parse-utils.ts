/**
 * Bun test output parsing utilities
 *
 * Extracted to a separate file to allow testing without importing mcpez
 */

export interface TestFailure {
	file: string
	message: string
	line?: number
	stack?: string
}

export interface TestSummary {
	passed: number
	failed: number
	total: number
	failures: TestFailure[]
}

/**
 * Parse bun test output to extract test results.
 *
 * The summary line (e.g., "3 pass\n0 fail") is the source of truth.
 * Console.error output from tests can create false positives if we
 * start failure blocks from orphan "error:" lines without a (fail) marker.
 *
 * Strategy:
 * 1. Extract pass/fail counts from summary FIRST
 * 2. If summary shows 0 failures, trust it and skip failure parsing
 * 3. Only parse failure details when summary indicates failures > 0
 * 4. In v1.3+ format, only create failures that have a (fail) marker
 */
export function parseBunTestOutput(output: string): TestSummary {
	// Extract summary FIRST - this is the source of truth
	const passMatch = output.match(/(\d+) pass/)
	const failMatch = output.match(/(\d+) fail/)

	const passed = passMatch?.[1] ? Number.parseInt(passMatch[1], 10) : 0
	const failedFromSummary = failMatch?.[1]
		? Number.parseInt(failMatch[1], 10)
		: null

	// If summary explicitly shows 0 failures, trust it - no need to parse details
	if (failedFromSummary === 0) {
		return { passed, failed: 0, total: passed, failures: [] }
	}

	// Parse failure details only when summary indicates failures (or no summary found)
	const failures = parseFailureDetails(output)

	// Use summary count if available, otherwise fall back to parsed count
	const failed = failedFromSummary ?? failures.length

	return {
		passed,
		failed,
		total: passed + failed,
		failures,
	}
}

/**
 * Parse failure details from bun test output.
 *
 * In Bun v1.3+ format, failures are marked by:
 * - error: ... (error message and diff)
 * - stack trace lines
 * - (fail) test name [time] (terminates the failure block)
 *
 * Orphan "error:" lines without a corresponding (fail) marker are likely
 * console.error output from tests and should NOT create failure blocks.
 */
function parseFailureDetails(output: string): TestFailure[] {
	const failures: TestFailure[] = []
	const lines = output.split('\n')
	let currentFailure: TestFailure | null = null
	let currentTestName: string | undefined

	for (const line of lines) {
		if (!line) continue

		// Bun v1.3+ format: "(fail) test name [0.21ms]" marks end of failure block
		// Extract test name and finalize the failure
		const failMatch = line.match(/\(fail\)\s+(.+?)\s+\[/)
		if (failMatch) {
			if (currentFailure) {
				// Use the test name from (fail) line as the primary identifier
				currentTestName = failMatch[1]
				currentFailure.message = `${currentTestName}: ${currentFailure.message}`
				failures.push(currentFailure)
				currentFailure = null
			}
			continue
		}

		// Legacy format: "✗ test name" or "FAIL file" marks start of failure
		if (line.includes('✗') || line.startsWith('FAIL ')) {
			if (currentFailure) failures.push(currentFailure)
			currentFailure = {
				file: 'unknown',
				message: line.trim(),
			}
			continue
		}

		// "error:" line in Bun v1.3+ format
		// Only append to existing failure context - DON'T start new failure blocks
		// from orphan error: lines, as these may be console.error output from tests.
		// Real failures in v1.3+ will be terminated by a (fail) marker.
		if (line.trim().startsWith('error:')) {
			if (currentFailure) {
				// Append error to existing failure
				currentFailure.message += `\n${line.trim()}`
			} else {
				// Start tentative failure block - will only be kept if (fail) marker follows
				currentFailure = {
					file: 'unknown',
					message: line.trim(),
				}
			}
			continue
		}

		// Capture content for current failure
		if (currentFailure) {
			// Stack trace line - extract file/line info
			if (line.trim().startsWith('at ')) {
				const match =
					line.match(/\((.+):(\d+):(\d+)\)/) ||
					line.match(/at (.+):(\d+):(\d+)/)
				if (match?.[1] && match[2]) {
					currentFailure.file = match[1]
					currentFailure.line = Number.parseInt(match[2], 10)
				}
				currentFailure.stack = `${currentFailure.stack || ''}${line}\n`
			} else if (line.trim() && !line.match(/^\d+ \| /)) {
				// Append to message (skip source code lines like "3 | test(...)")
				currentFailure.message += `\n${line.trim()}`
			}
		}
	}

	// For legacy format (✗ or FAIL), push remaining failure
	// For v1.3+ format, orphan failures without (fail) marker are discarded
	// as they're likely console.error output
	if (currentFailure && (currentFailure.message.includes('✗') || currentFailure.message.startsWith('FAIL '))) {
		failures.push(currentFailure)
	}

	return failures
}
