import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { stampUsageSource, withUsageSource } from '../usage/source.ts'
import type { AutoTier, AutoTierRoute } from './types.ts'

const CLASSIFIER_MAX_TOKENS = 16
const CLASSIFIER_TIMEOUT_MS = 4000
/**
 * Bilingual agentic rubric: routine engineering stays at thinking;
 * only hard reasoning / high-risk work escalates to pro.
 */
const CLASSIFIER_SYSTEM = [
  'You route coding-agent turns. Reply with exactly one word: instant, thinking, or pro.',
  'instant — trivial lookup, short rewrite, yes/no, or a single obvious edit; no tools needed.',
  'thinking — normal engineering: multi-file edits, installs, standard debugging, tools, refactors of moderate scope.',
  'pro — hardest work: deep root-cause, architecture trade-offs, concurrency/security-critical changes, long multi-step plans.',
  'Do not overuse pro for routine agent work. Prefer thinking when unsure.',
  '中文同样适用：短问答/简单改写→instant；常规改代码/排错/用工具→thinking；疑难根因/架构权衡/高风险改动→pro。',
  'Output only: instant | thinking | pro',
].join('\n')
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
  if (route.provider === '' || route.model === '') {
    return async () => { throw new Error('Classifier route unavailable') }
  }
  return async (text, signal) => withUsageSource('autoClassifier', async () => {
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
      stampUsageSource(options, 'autoClassifier')
      for await (const chunk of call.stream(options)) {
        timeout.signal.throwIfAborted()
        if (chunk.type === 'tool-call-delta') continue
        assembler.push(chunk)
      }
      timeout.signal.throwIfAborted()
      const raw = classifierOutputText(assembler)
      const tier = parseClassifierTier(raw)
      if (tier !== undefined) return tier
      if (assembler.finish.kind !== 'stop') {
        throw new Error('Classifier finished without stop')
      }
      throw new Error(`Invalid classifier output: ${raw}`)
    } finally {
      clearTimeout(timer)
      unlink?.()
    }
  })
}
