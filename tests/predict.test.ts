import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuxiliaryResult, PredictRequest, RecentExchange } from '../src/host/types.ts'
import { Coordinator } from '../src/client/prompt/coordinator.ts'
import type { PromptInput } from '../src/client/prompt/coordinator.ts'
import { PredictionController, PredictionGate } from '../src/client/prompt/predict.ts'
import type { PredictionRequest } from '../src/client/prompt/predict.ts'
import type { DraftWriter, KeyContext } from '../src/client/prompt/types.ts'

const session = (value: string): SessionId => value as SessionId
const exchange: RecentExchange = { turn: 1, prompt: 'first prompt', response: 'first response' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const key: KeyContext = {
  composing: false,
  systemLayerOpen: false,
  officialMenuOpen: false,
  atFirstLine: true,
  atLastLine: true,
}

function request(overrides: Partial<PredictionRequest> = {}): PredictionRequest {
  return {
    sessionId: session('a'),
    turn: 1,
    draftRev: 1,
    context: [exchange],
    ...overrides,
  }
}

interface HarnessOptions {
  input?: Partial<PromptInput>
  context?: readonly RecentExchange[]
  generate?: (request: PredictRequest, signal: AbortSignal) => Promise<AuxiliaryResult | null>
}

function harness(options: HarnessOptions = {}) {
  let input: PromptInput = {
    sessionId: session('a'),
    draft: '',
    draftRev: 1,
    selection: { start: 0, end: 0 },
    occurrences: [],
    running: false,
    ...options.input,
  }
  let context = options.context ?? [exchange]
  const drafts: Array<{ text: string; caret: number }> = []
  const writer: DraftWriter = {
    replace: () => { throw new Error('prediction must not replace a selection') },
    setDraft: (text, caret) => { drafts.push({ text, caret }) },
  }
  const switches = { predict: true }
  const coordinator = new Coordinator(writer, {
    history: () => false,
    optimize: () => false,
    predict: () => switches.predict,
  })
  const generate = vi.fn(options.generate ?? (async (prediction: PredictRequest): Promise<AuxiliaryResult> => ({
    requestId: prediction.requestId,
    text: '  next prompt  ',
    route: { provider: 'p', model: 'm' },
  })))
  const controller = new PredictionController(coordinator, generate)
  const sync = () => {
    coordinator.sync(input)
    controller.sync(input, context)
  }
  return {
    controller,
    coordinator,
    generate,
    drafts,
    switches,
    sync,
    input: () => input,
    setInput(value: PromptInput) { input = value },
    setContext(value: readonly RecentExchange[]) { context = value },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('PredictionGate', () => {
  it('admits an idle empty draft after a settled turn', () => {
    const gate = new PredictionGate()
    expect(gate.shouldStart(request(), false, '')).toBe(true)
  })

  it.each([
    ['running', true, '', 1],
    ['a non-empty draft', false, 'typed', 1],
    ['turn zero', false, '', 0],
  ])('rejects %s', (_name, running, draft, turn) => {
    const gate = new PredictionGate()
    expect(gate.shouldStart(request({ turn }), running, draft)).toBe(false)
  })

  it('deduplicates a marked turn independently per session', () => {
    const gate = new PredictionGate()
    const first = request()
    gate.mark(first)

    expect(gate.shouldStart(first, false, '')).toBe(false)
    expect(gate.shouldStart(request({ turn: 2 }), false, '')).toBe(true)
    expect(gate.shouldStart(request({ sessionId: session('b') }), false, '')).toBe(true)
  })
})

describe('PredictionController', () => {
  it.each([
    ['running', { input: { running: true } }],
    ['a non-empty draft', { input: { draft: 'typed' } }],
    ['turn zero', { context: [{ ...exchange, turn: 0 }] }],
    ['no settled turn', { context: [] }],
    ['a blank session', { input: { sessionId: session('   ') } }],
  ])('does not request for %s', (_name, options: HarnessOptions) => {
    const h = harness(options)
    h.sync()
    expect(h.generate).not.toHaveBeenCalled()
  })

  it('marks before requesting so a reentrant sync cannot duplicate the Host call', () => {
    let syncAgain = () => {}
    const h = harness({
      generate: async prediction => {
        syncAgain()
        return { requestId: prediction.requestId, text: 'next', route: { provider: 'p', model: 'm' } }
      },
    })
    syncAgain = h.sync

    h.sync()

    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.generate.mock.calls[0]?.[0]).toEqual({
      operation: 'predict',
      requestId: 'predict-1',
      sessionId: session('a'),
      context: [exchange],
    })
  })

  it('shows one trimmed suggestion and requests a successful turn only once', async () => {
    const h = harness()
    h.sync()
    await flush()

    expect(h.coordinator.predictionSnapshot()).toBe('next prompt')
    h.sync()
    await flush()
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.coordinator.predictionSnapshot()).toBe('next prompt')
  })

  it.each([
    ['null', async () => null],
    ['whitespace', async (prediction: PredictRequest): Promise<AuxiliaryResult> => ({
      requestId: prediction.requestId, text: ' \n\t ', route: { provider: 'p', model: 'm' },
    })],
  ])('does not display a %s result', async (_name, generate) => {
    const h = harness({ generate })
    h.sync()
    await flush()
    expect(h.coordinator.predictionSnapshot()).toBeNull()
  })

  it('does not retry a failed turn on later syncs or timers', async () => {
    vi.useFakeTimers()
    const h = harness({ generate: async () => { throw new Error('provider failed') } })
    h.sync()
    await flush()

    h.sync()
    await vi.advanceTimersByTimeAsync(60_000)
    h.sync()

    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.coordinator.predictionSnapshot()).toBeNull()
  })

  it('drops a result whose requestId does not match', async () => {
    const h = harness({ generate: async () => ({
      requestId: 'older-request', text: 'stale', route: { provider: 'p', model: 'm' },
    }) })
    h.sync()
    await flush()
    expect(h.coordinator.predictionSnapshot()).toBeNull()
  })

  it.each([
    ['typed input', { draft: 'typed', draftRev: 2 }, [exchange]],
    ['a draft revision', { draftRev: 2 }, [exchange]],
    ['turn start', { running: true }, [exchange]],
    ['a new turn', { running: true }, [{ ...exchange, turn: 2 }]],
    ['a session switch', { sessionId: session('b'), draft: 'typed' }, [exchange]],
  ])('aborts and drops a late result after %s', async (_name, changed, nextContext) => {
    const pending = deferred<AuxiliaryResult>()
    let signal!: AbortSignal
    const h = harness({ generate: (_request, requestSignal) => {
      signal = requestSignal
      return pending.promise
    } })
    h.sync()
    h.setInput({ ...h.input(), ...changed })
    h.setContext(nextContext)
    h.sync()

    expect(signal.aborted).toBe(true)
    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'stale', route: { provider: 'p', model: 'm' } })
    await flush()
    expect(h.coordinator.predictionSnapshot()).toBeNull()
  })

  it.each(['module', 'menu', 'dispose'] as const)('aborts and drops a late result on %s', async close => {
    const pending = deferred<AuxiliaryResult>()
    let signal!: AbortSignal
    const h = harness({ generate: (_request, requestSignal) => {
      signal = requestSignal
      return pending.promise
    } })
    h.sync()

    if (close === 'module') h.controller.setEnabled(false)
    else if (close === 'menu') h.controller.cancel()
    else h.controller.dispose()
    expect(signal.aborted).toBe(true)

    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'stale', route: { provider: 'p', model: 'm' } })
    await flush()
    expect(h.coordinator.predictionSnapshot()).toBeNull()
  })

  it('clears a visible suggestion on input, menu cancellation, and module disable', async () => {
    const h = harness()
    h.sync()
    await flush()
    expect(h.coordinator.predictionSnapshot()).toBe('next prompt')

    h.setInput({ ...h.input(), draft: 'x', draftRev: 2 })
    h.sync()
    expect(h.coordinator.predictionSnapshot()).toBeNull()

    h.setInput({ ...h.input(), draft: '', draftRev: 3 })
    h.setContext([{ ...exchange, turn: 2 }])
    h.sync()
    await flush()
    h.controller.cancel()
    expect(h.coordinator.predictionSnapshot()).toBeNull()

    h.setContext([{ ...exchange, turn: 3 }])
    h.sync()
    await flush()
    h.controller.setEnabled(false)
    expect(h.coordinator.predictionSnapshot()).toBeNull()
  })

  it('does not request the same turn again when the module is re-enabled', async () => {
    const h = harness()
    h.sync()
    await flush()
    h.controller.setEnabled(false)
    h.controller.setEnabled(true)
    h.sync()
    expect(h.generate).toHaveBeenCalledTimes(1)
  })

  it('adopts the full suggestion as the real draft without submitting', async () => {
    const h = harness()
    h.sync()
    await flush()

    expect(h.coordinator.handleKey('tab', key)).toBe(true)
    expect(h.drafts).toEqual([{ text: 'next prompt', caret: 11 }])
    expect(h.coordinator.predictionSnapshot()).toBeNull()
    expect(h.coordinator.handleKey('tab', key)).toBe(false)
  })
})
