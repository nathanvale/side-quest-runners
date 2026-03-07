import { AsyncLocalStorage } from 'node:async_hooks'
import {
	configure,
	fingersCrossed,
	getLogger,
	getStreamSink,
	jsonLinesFormatter,
} from '@logtape/logtape'

const metricsLogger = getLogger(['side-quest', 'hooks', 'metrics'])
let observabilityReady: Promise<void> | null = null

/**
 * Configure stderr-only JSONL logging so stdout remains Claude-hook JSON only.
 */
export function setupObservability(): Promise<void> {
	if (observabilityReady) {
		return observabilityReady
	}
	observabilityReady = configure({
		reset: true,
		contextLocalStorage: new AsyncLocalStorage<Record<string, unknown>>(),
		sinks: {
			stderrBuffered: fingersCrossed(
				getStreamSink(createBunStderrWritableStream(), {
					formatter: jsonLinesFormatter,
				}),
				{
					triggerLevel: 'warning',
					maxBufferSize: 200,
					isolateByCategory: 'descendant',
				},
			),
			stderrDirect: getStreamSink(createBunStderrWritableStream(), {
				formatter: jsonLinesFormatter,
			}),
		},
		loggers: [
			{
				category: ['side-quest', 'hooks', 'metrics'],
				sinks: ['stderrDirect'],
				lowestLevel: 'info',
			},
			{
				category: ['side-quest', 'hooks'],
				sinks: ['stderrBuffered'],
				lowestLevel: 'info',
			},
			{
				category: ['logtape'],
				sinks: ['stderrBuffered'],
				lowestLevel: 'error',
			},
		],
	})
	return observabilityReady
}

/**
 * Emit one structured metric event to LogTape stderr sinks.
 */
export function emitMetric(
	metric: string,
	properties?: Record<string, unknown>,
): void {
	metricsLogger.info(metric, {
		metric,
		...(properties ?? {}),
	})
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
	})
}
