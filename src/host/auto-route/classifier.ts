import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { AutoTier, AutoTierRoute } from './types.ts'

const CLASSIFIER_MAX_TOKENS = 8
const CLASSIFIER_TIMEOUT_MS = 4000
const CLASSIFIER_SYSTEM = 'Output only one word: instant, thinking, or pro.'
const TIER_WORD = /\b(instant|thinking|pro)\b/i

export function parseClassifierTier(raw: string): AutoTier | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined

  const direct = trimmed.toLowerCase()
  if (direct === 'instant' || direct === 'thinking' || direct === 'pro') {
    return direct
  }

  const match = TIER_WORD.exec(trimmed)
  if (match === null) return undefined
  return match[1]!.toLowerCase() as AutoTier
}

function classifierOutputText(assembler: BlockAssembler): string {
  const blocks = assembler.blocks()
  let text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  const paired = /^(`{1,3})([\s\S]*?)\1$/.exec(text)
  if (paired !== null) text = paired[2]!.trim()
  return text
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const forward = () => { target.abort(source.reason) }
  if (source.aborted) forward()
  else source.addEventListener('abort', forward, { once: true })
  return () => { source.removeEventListener('abort', forward) }
}

export function createClassifier(
  llm: Pick<LlmRuntime, 'prepareCall'>,
  route: AutoTierRoute,
): (text: string, signal?: AbortSignal) => Promise<AutoTier> {
  return async (text, signal) => {
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort() }, CLASSIFIER_TIMEOUT_MS)
    const unlink = signal === undefined ? undefined : linkAbortSignal(signal, timeout)
    try {
      timeout.signal.throwIfAborted()
      const call = await llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: CLASSIFIER_MAX_TOKENS },
        timeout.signal,
      )
      timeout.signal.throwIfAborted()
      const assembler = new BlockAssembler()
      const options: GenerateOptions = {
        ...call.config,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        tools: [],
        signal: timeout.signal,
      }
      for await (const chunk of call.stream(options)) {
        timeout.signal.throwIfAborted()
        if (chunk.type === 'tool-call-delta') continue
        assembler.push(chunk)
      }
      timeout.signal.throwIfAborted()
      if (assembler.finish.kind !== 'stop') {
        throw new Error('Classifier finished without stop')
      }
      const raw = classifierOutputText(assembler)
      const tier = parseClassifierTier(raw)
      if (tier === undefined) throw new Error(`Invalid classifier output: ${raw}`)
      return tier
    } finally {
      clearTimeout(timer)
      unlink?.()
    }
  }
}
