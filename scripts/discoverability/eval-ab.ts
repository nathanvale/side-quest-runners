#!/usr/bin/env bun

/**
 * A/B discoverability evaluator for MCP tool descriptions.
 *
 * Why: This compares routing quality for pre-uplift descriptions vs
 * post-uplift descriptions so we can quantify whether the uplift improved
 * (or regressed) first-choice tool selection.
 */

type ToolDef = {
	name: string
	title: string
	description: string
}

type PromptCase = {
	id: string
	prompt: string
	expected: string
	confusionPair: string
}

type RouterPick = {
	first: string
	second: string
}

type VariantName = 'before-uplift' | 'after-uplift'

const TOOLS_BEFORE_UPLIFT: ToolDef[] = [
	{
		name: 'tsc_check',
		title: 'TypeScript Type Checker',
		description:
			'Run TypeScript type checking (tsc --noEmit) using the nearest tsconfig/jsconfig.',
	},
	{
		name: 'bun_runTests',
		title: 'Bun Test Runner',
		description:
			"Run tests using Bun and return a concise summary of failures. Use this instead of 'bun test' to save tokens and get structured error reports.",
	},
	{
		name: 'bun_testFile',
		title: 'Bun Single File Test Runner',
		description:
			'Run tests for a specific file only. More targeted than bun_runTests with a pattern.',
	},
	{
		name: 'bun_testCoverage',
		title: 'Bun Test Coverage Reporter',
		description:
			'Run tests with code coverage and return a summary. Shows overall coverage percentage and files with low coverage.',
	},
	{
		name: 'biome_lintCheck',
		title: 'Biome Lint Checker',
		description:
			'Run Biome linter on files and return structured errors. Use this to check for code quality issues without fixing them.',
	},
	{
		name: 'biome_lintFix',
		title: 'Biome Lint & Format Fixer',
		description:
			'Run Biome linter with --write to auto-fix issues. Returns count of fixed issues and any remaining unfixable errors.',
	},
	{
		name: 'biome_formatCheck',
		title: 'Biome Format Checker',
		description:
			'Check if files are properly formatted without making changes. Returns list of unformatted files.',
	},
]

const TOOLS_AFTER_UPLIFT: ToolDef[] = [
	{
		name: 'tsc_check',
		title: 'TypeScript Type Checker',
		description:
			'Type-check TS/JS with tsc --noEmit using nearest tsconfig/jsconfig. Use after edits. Returns errorCount and file/line/column/message diagnostics. Read-only. Not for lint/format/tests; use biome_lintCheck or bun_runTests.',
	},
	{
		name: 'bun_runTests',
		title: 'Bun Test Runner',
		description:
			'Run Bun tests for suite-level regression checks. Returns pass/fail counts and structured failures. Read-only. No fixes or coverage. Use bun_testFile for one file; bun_testCoverage for coverage.',
	},
	{
		name: 'bun_testFile',
		title: 'Bun Single File Test Runner',
		description:
			'Run Bun tests for one exact test file path with structured failures. Use during focused debugging. Read-only. Not full-suite or coverage. Use bun_runTests for suite checks; bun_testCoverage for coverage.',
	},
	{
		name: 'bun_testCoverage',
		title: 'Bun Test Coverage Reporter',
		description:
			'Run Bun tests with coverage. Returns test summary, coverage percent, and low-coverage files. Read-only and slower than bun_runTests. No fixes. Use bun_runTests for faster no-coverage checks.',
	},
	{
		name: 'biome_lintCheck',
		title: 'Biome Lint Checker',
		description:
			'Run Biome lint checks on a file or directory. Returns error/warning counts and structured diagnostics. Read-only. Does not write fixes. Use biome_lintFix to apply fixes.',
	},
	{
		name: 'biome_lintFix',
		title: 'Biome Lint Fixer',
		description:
			'Run Biome format/check with --write to auto-fix issues. Returns fixed counts and remaining diagnostics. Writes files. Use biome_lintCheck for read-only inspection.',
	},
	{
		name: 'biome_formatCheck',
		title: 'Biome Format Checker',
		description:
			'Check whether files are formatted with Biome without writing changes. Returns formatted status and unformatted files. Read-only. Use biome_lintFix to apply formatting.',
	},
]

const PROMPTS_CORE: PromptCase[] = [
	{
		id: 'P01',
		prompt: 'Check types before commit',
		expected: 'tsc_check',
		confusionPair: 'tsc_check vs biome_lintCheck',
	},
	{
		id: 'P02',
		prompt: 'Fix lint and formatting in src',
		expected: 'biome_lintFix',
		confusionPair: 'biome_lintFix vs biome_lintCheck',
	},
	{
		id: 'P03',
		prompt: 'Only check lint, do not change files',
		expected: 'biome_lintCheck',
		confusionPair: 'biome_lintCheck vs biome_lintFix',
	},
	{
		id: 'P04',
		prompt: 'Which files are unformatted?',
		expected: 'biome_formatCheck',
		confusionPair: 'biome_formatCheck vs biome_lintCheck',
	},
	{
		id: 'P05',
		prompt: 'Run all tests quickly',
		expected: 'bun_runTests',
		confusionPair: 'bun_runTests vs bun_testCoverage',
	},
	{
		id: 'P06',
		prompt: 'Run tests for src/auth/login.test.ts only',
		expected: 'bun_testFile',
		confusionPair: 'bun_testFile vs bun_runTests',
	},
	{
		id: 'P07',
		prompt: 'Give me coverage before release',
		expected: 'bun_testCoverage',
		confusionPair: 'bun_testCoverage vs bun_runTests',
	},
	{
		id: 'P08',
		prompt: 'Type errors only, no lint',
		expected: 'tsc_check',
		confusionPair: 'tsc_check vs biome_lintCheck',
	},
	{
		id: 'P09',
		prompt: 'Auto-fix style issues',
		expected: 'biome_lintFix',
		confusionPair: 'biome_lintFix vs biome_formatCheck',
	},
	{
		id: 'P10',
		prompt: 'Read-only formatting gate for CI',
		expected: 'biome_formatCheck',
		confusionPair: 'biome_formatCheck vs biome_lintFix',
	},
]

const PROMPTS_STRESS: PromptCase[] = [
	...PROMPTS_CORE,
	{
		id: 'S01',
		prompt: 'quickly run tests for the whole repo, no coverage',
		expected: 'bun_runTests',
		confusionPair: 'bun_runTests vs bun_testCoverage',
	},
	{
		id: 'S02',
		prompt: 'run only tests in packages/bun-runner/mcp/index.test.ts',
		expected: 'bun_testFile',
		confusionPair: 'bun_testFile vs bun_runTests',
	},
	{
		id: 'S03',
		prompt: 'what is our test coverage right now?',
		expected: 'bun_testCoverage',
		confusionPair: 'bun_testCoverage vs bun_runTests',
	},
	{
		id: 'S04',
		prompt: 'lint this package but do not touch files',
		expected: 'biome_lintCheck',
		confusionPair: 'biome_lintCheck vs biome_lintFix',
	},
	{
		id: 'S05',
		prompt: 'rewrite files to fix lint issues',
		expected: 'biome_lintFix',
		confusionPair: 'biome_lintFix vs biome_lintCheck',
	},
	{
		id: 'S06',
		prompt: 'check style formatting only in read-only mode',
		expected: 'biome_formatCheck',
		confusionPair: 'biome_formatCheck vs biome_lintCheck',
	},
	{
		id: 'S07',
		prompt: 'validate types only, skip lint and tests',
		expected: 'tsc_check',
		confusionPair: 'tsc_check vs biome_lintCheck',
	},
	{
		id: 'S08',
		prompt: 'fix formatting drift before merge',
		expected: 'biome_lintFix',
		confusionPair: 'biome_lintFix vs biome_formatCheck',
	},
	{
		id: 'S09',
		prompt: 'which files violate formatting rules?',
		expected: 'biome_formatCheck',
		confusionPair: 'biome_formatCheck vs biome_lintCheck',
	},
	{
		id: 'S10',
		prompt: 'full test run after refactor',
		expected: 'bun_runTests',
		confusionPair: 'bun_runTests vs bun_testFile',
	},
	{
		id: 'S11',
		prompt: 'run coverage pass for release notes',
		expected: 'bun_testCoverage',
		confusionPair: 'bun_testCoverage vs bun_runTests',
	},
	{
		id: 'S12',
		prompt: 'targeted test rerun for one failing file path',
		expected: 'bun_testFile',
		confusionPair: 'bun_testFile vs bun_runTests',
	},
]

function parseArg(name: string, fallback: string): string {
	const exact = Bun.argv.find((arg) => arg.startsWith(`${name}=`))
	if (!exact) {
		return fallback
	}
	return exact.slice(name.length + 1)
}

function parseIntArg(name: string, fallback: number): number {
	const raw = parseArg(name, `${fallback}`)
	const parsed = Number.parseInt(raw, 10)
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseFloatArg(name: string, fallback: number): number {
	const raw = parseArg(name, `${fallback}`)
	const parsed = Number.parseFloat(raw)
	return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeToolName(raw: string, allowed: string[]): string | null {
	const cleaned = raw.trim().replace(/^`|`$/g, '')
	if (allowed.includes(cleaned)) {
		return cleaned
	}
	return null
}

function fallbackSecond(first: string, allowed: string[]): string {
	const candidate = allowed.find((name) => name !== first)
	if (!candidate) {
		throw new Error('No alternate tool available for second choice fallback.')
	}
	return candidate
}

async function pickWithOpenAI(
	model: string,
	apiKey: string,
	tools: ToolDef[],
	promptCase: PromptCase,
	temperature: number,
): Promise<RouterPick> {
	const allowedToolNames = tools.map((t) => t.name)
	const toolList = tools
		.map((tool) => `- ${tool.name}: ${tool.description}`)
		.join('\n')

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model,
			temperature,
			messages: [
				{
					role: 'system',
					content:
						'You are a tool router. Choose tools only from the provided list. Respond with strict JSON object: {"first":"tool_name","second":"tool_name"}. second must differ from first.',
				},
				{
					role: 'user',
					content: `Task request:\n${promptCase.prompt}\n\nAvailable tools:\n${toolList}\n\nReturn only JSON.`,
				},
			],
			response_format: {
				type: 'json_object',
			},
		}),
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`OpenAI request failed (${response.status}): ${text}`)
	}

	const json = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>
	}
	const raw = json.choices?.[0]?.message?.content ?? '{}'
	let parsed: RouterPick | null = null
	try {
		parsed = JSON.parse(raw) as RouterPick
	} catch {
		throw new Error(`Router returned invalid JSON: ${raw}`)
	}

	const first = normalizeToolName(parsed.first, allowedToolNames)
	const second = normalizeToolName(parsed.second, allowedToolNames)

	if (!first) {
		throw new Error(
			`Router returned invalid tool names: first=${parsed.first}, second=${parsed.second}`,
		)
	}

	if (!second || first === second) {
		return { first, second: fallbackSecond(first, allowedToolNames) }
	}

	return { first, second }
}

function computeMetrics(
	rows: Array<{
		variant: VariantName
		promptId: string
		expected: string
		confusionPair: string
		first: string
		second: string
	}>,
) {
	const grouped = {
		'before-uplift': rows.filter((r) => r.variant === 'before-uplift'),
		'after-uplift': rows.filter((r) => r.variant === 'after-uplift'),
	} as const

	const byVariant = Object.fromEntries(
		(Object.keys(grouped) as VariantName[]).map((variant) => {
			const subset = grouped[variant]
			const total = subset.length
			const firstCorrect = subset.filter((r) => r.first === r.expected).length
			const secondCorrectOnly = subset.filter(
				(r) => r.first !== r.expected && r.second === r.expected,
			).length
			const miss = total - firstCorrect - secondCorrectOnly
			const meanExtraCalls =
				total === 0
					? 0
					: (secondCorrectOnly * 1 + miss * 2 + firstCorrect * 0) / total

			const confusionPairs = [...new Set(subset.map((r) => r.confusionPair))]
				.sort()
				.map((pair) => {
					const pairRows = subset.filter((r) => r.confusionPair === pair)
					const correct = pairRows.filter((r) => r.first === r.expected).length
					return {
						pair,
						trials: pairRows.length,
						correct,
						accuracy: pairRows.length === 0 ? 0 : correct / pairRows.length,
					}
				})

			return [
				variant,
				{
					trials: total,
					firstChoiceAccuracy: total === 0 ? 0 : firstCorrect / total,
					firstCorrect,
					secondCorrectOnly,
					miss,
					meanExtraCalls,
					confusionPairs,
				},
			]
		}),
	)

	const delta = {
		firstChoiceAccuracy:
			byVariant['after-uplift'].firstChoiceAccuracy -
			byVariant['before-uplift'].firstChoiceAccuracy,
		meanExtraCalls:
			byVariant['after-uplift'].meanExtraCalls -
			byVariant['before-uplift'].meanExtraCalls,
	}

	return { byVariant, delta }
}

async function main(): Promise<void> {
	const apiKey = process.env.OPENAI_API_KEY
	if (!apiKey) {
		throw new Error('OPENAI_API_KEY is required for llm routing eval.')
	}

	const model = parseArg('--model', process.env.OPENAI_MODEL || 'gpt-4.1-mini')
	const repeats = parseIntArg('--repeats', 3)
	const temperature = parseFloatArg('--temperature', 0.2)
	const suiteArg = parseArg('--suite', 'core')
	const prompts = suiteArg === 'stress' ? PROMPTS_STRESS : PROMPTS_CORE
	const outPath = parseArg(
		'--out',
		`reports/discoverability-ab-${new Date().toISOString().replaceAll(':', '-')}.json`,
	)

	const variants: Array<{ name: VariantName; tools: ToolDef[] }> = [
		{ name: 'before-uplift', tools: TOOLS_BEFORE_UPLIFT },
		{ name: 'after-uplift', tools: TOOLS_AFTER_UPLIFT },
	]

	const rows: Array<{
		variant: VariantName
		promptId: string
		prompt: string
		expected: string
		confusionPair: string
		first: string
		second: string
	}> = []

	for (const variant of variants) {
		for (const promptCase of prompts) {
			for (let i = 0; i < repeats; i += 1) {
				const pick = await pickWithOpenAI(
					model,
					apiKey,
					variant.tools,
					promptCase,
					temperature,
				)
				rows.push({
					variant: variant.name,
					promptId: promptCase.id,
					prompt: promptCase.prompt,
					expected: promptCase.expected,
					confusionPair: promptCase.confusionPair,
					first: pick.first,
					second: pick.second,
				})
			}
		}
	}

	const metrics = computeMetrics(rows)
	const output = {
		createdAt: new Date().toISOString(),
		model,
		repeats,
		temperature,
		suite: suiteArg,
		promptCount: prompts.length,
		variants: {
			beforeUplift: TOOLS_BEFORE_UPLIFT.map((t) => ({
				name: t.name,
				title: t.title,
			})),
			afterUplift: TOOLS_AFTER_UPLIFT.map((t) => ({
				name: t.name,
				title: t.title,
			})),
		},
		metrics,
		rows,
	}

	await Bun.write(outPath, JSON.stringify(output, null, 2))

	const summary = {
		outPath,
		model,
		repeats,
		suite: suiteArg,
		promptCount: prompts.length,
		beforeUplift: metrics.byVariant['before-uplift'],
		afterUplift: metrics.byVariant['after-uplift'],
		delta: metrics.delta,
	}
	console.log(JSON.stringify(summary, null, 2))
}

await main()
