import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { classifyUsageSource } from './source.ts'
import { normalizeReasoningEffort, usageCallFromReport } from './summarize.ts'
import type { UsageCall, UsageSource } from './types.ts'

export interface UsageRecorder {
  record(call: UsageCall): void
}

export async function* observeModelStream(
  options: GenerateOptions,
  source: AsyncIterable<StreamChunk>,
  record: (call: UsageCall) => void,
  now: () => number = Date.now,
  attributed: UsageSource = classifyUsageSource(options),
): AsyncGenerator<StreamChunk> {
  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort)
  for await (const chunk of source) {
    if (chunk.type === 'usage') {
      try {
        const call = usageCallFromReport(
          attributed,
          options.provider,
          options.model,
          chunk.usage,
          now(),
          reasoningEffort,
        )
        if (call !== undefined) record(call)
      } catch {
        // Recording the bill must not fail the model call.
      }
    }
    yield chunk
  }
}

export function installUsageObserver(ctx: Context, recorder: UsageRecorder): void {
  // Classify synchronously inside the waterfall listener — still on the same
  // tick as `call.stream()` / `withUsageSource` — before the async generator
  // body runs and before ALS can be lost across Cordis scheduling.
  ctx.on('llm/stream', (options, next) => {
    const attributed = classifyUsageSource(options)
    return observeModelStream(
      options,
      next(),
      call => { recorder.record(call) },
      Date.now,
      attributed,
    )
  })
}
