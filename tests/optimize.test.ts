import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import type { AuxiliaryResult, OptimizeRequest, RecentExchange } from '../src/host/types.ts'
import { Coordinator } from '../src/client/prompt/coordinator.ts'
import type { PromptInput } from '../src/client/prompt/coordinator.ts'
import { OptimizationController, OptimizationStore } from '../src/client/prompt/optimize.ts'
import type { DraftSelection, DraftSnapshot, DraftWriter } from '../src/client/prompt/types.ts'
import { AuxiliaryError } from '../src/errors.ts'

const session = (value: string): SessionId => value as SessionId
const context: readonly RecentExchange[] = [{ turn: 1, prompt: 'old prompt', response: 'old response' }]

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

type Occurrence = InputState['occurrences'][number]

class Writer implements DraftWriter {
  readonly replacements: Array<{ text: string; selection: DraftSelection; segments?: readonly string[] }> = []
  acceptReplace = true

  constructor(private readonly input: () => PromptInput, private readonly update: (draft: string, caret: number) => void) {}

  replace(text: string, selection: DraftSelection, segments?: readonly string[]): boolean {
    this.replacements.push({ text, selection, ...(segments === undefined ? {} : { segments }) })
    const current = this.input()
    if (!this.acceptReplace || selection.sessionId !== current.sessionId || selection.draftRev !== current.draftRev) return false
    this.update(
      current.draft.slice(0, selection.start) + text + current.draft.slice(selection.end),
      selection.start + text.length,
    )
    return true
  }

  setDraft(): void {
    throw new Error('optimization must use guarded replacement')
  }
}

interface HarnessOptions {
  draft?: string
  selection?: { start: number; end: number }
  occurrences?: readonly Occurrence[]
  generate?: (request: OptimizeRequest, signal: AbortSignal) => Promise<AuxiliaryResult | null>
}

function harness(options: HarnessOptions = {}) {
  let input: PromptInput = {
    sessionId: session('a'),
    draft: options.draft ?? 'source',
    draftRev: 1,
    selection: options.selection ?? { start: 0, end: 0 },
    occurrences: options.occurrences ?? [],
    running: false,
  }
  const replace = (draft: string, caret: number) => {
    input = { ...input, draft, draftRev: input.draftRev + 1, selection: { start: caret, end: caret } }
  }
  const writer = new Writer(() => input, replace)
  const switches = { history: () => false, optimize: () => true, predict: () => false }
  const coordinator = new Coordinator(writer, switches)
  const generate = vi.fn(options.generate ?? (async (request: OptimizeRequest): Promise<AuxiliaryResult> => ({
    requestId: request.requestId,
    text: 'optimized',
    route: { provider: 'host-only', model: 'host-model' },
  })))
  const controller = new OptimizationController(coordinator, generate)
  const snapshot = (): DraftSnapshot => ({
    sessionId: input.sessionId,
    draftRev: input.draftRev,
    start: input.selection.start,
    end: input.selection.end,
    text: input.draft,
    ...(input.selection.start === input.selection.end && input.occurrences.length > 0
      ? { structured: true, occurrences: input.occurrences }
      : {}),
  })
  const sync = () => {
    coordinator.sync(input)
    controller.sync(snapshot())
  }
  const edit = (draft: string, draftRev = input.draftRev + 1) => {
    input = { ...input, draft, draftRev }
    sync()
  }
  sync()
  return {
    controller,
    coordinator,
    generate,
    writer,
    snapshot,
    sync,
    edit,
    input: () => input,
    setInput(value: PromptInput) { input = value },
  }
}

describe('OptimizationStore', () => {
  it('retains one source-matched cache and invalidates it explicitly', () => {
    const store = new OptimizationStore()
    const first = {
      source: 'first',
      optimized: 'better first',
      selection: { sessionId: session('a'), draftRev: 1, start: 0, end: 5 },
    }
    store.write(first)
    expect(store.read('first')).toBe(first)
    expect(store.read('other')).toBeNull()

    const second = { ...first, source: 'second', optimized: 'better second' }
    store.write(second)
    expect(store.read('first')).toBeNull()
    expect(store.read('second')).toBe(second)
    store.invalidate()
    expect(store.read('second')).toBeNull()
  })
})

describe('OptimizationController', () => {
  it('completes click, pending, replacement, undo, and cached re-optimization with one Host call', async () => {
    const pending = deferred<AuxiliaryResult>()
    const h = harness({ generate: () => pending.promise })

    const started = h.controller.start(h.snapshot(), context)
    expect(h.controller.getSnapshot()).toEqual({ status: 'pending', error: null })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.generate.mock.calls[0]?.[0]).toMatchObject({
      operation: 'optimize', sessionId: session('a'), source: 'source', references: [], context,
    })
    expect(h.generate.mock.calls[0]?.[0]).not.toHaveProperty('provider')
    expect(h.generate.mock.calls[0]?.[0]).not.toHaveProperty('model')

    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'better', route: { provider: 'p', model: 'm' } })
    await started
    expect(h.input().draft).toBe('better')
    h.sync()
    expect(h.controller.getSnapshot()).toEqual({ status: 'undo', error: null })

    expect(h.controller.undo()).toBe(true)
    expect(h.input().draft).toBe('source')
    h.sync()
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: null })

    const cached = h.controller.start(h.snapshot(), context)
    expect(h.input().draft).toBe('better')
    await cached
    expect(h.generate).toHaveBeenCalledTimes(1)
  })

  it('replaces only the captured selection and leaves following text unchanged through undo and reuse', async () => {
    const h = harness({ draft: 'before old after', selection: { start: 7, end: 10 } })
    await h.controller.start(h.snapshot(), context)
    expect(h.input().draft).toBe('before optimized after')
    expect(h.input().selection).toEqual({ start: 16, end: 16 })
    h.sync()

    expect(h.controller.undo()).toBe(true)
    expect(h.input().draft).toBe('before old after')
    expect(h.input().selection).toEqual({ start: 10, end: 10 })
    h.sync()
    await h.controller.start(h.snapshot(), context)
    expect(h.input().draft).toBe('before optimized after')
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.writer.replacements.map(entry => entry.selection)).toEqual([
      { sessionId: session('a'), draftRev: 1, start: 7, end: 10 },
      { sessionId: session('a'), draftRev: 2, start: 7, end: 16 },
      { sessionId: session('a'), draftRev: 3, start: 7, end: 10 },
    ])
  })

  it('optimizes a new non-empty selection instead of reusing the undone span', async () => {
    const h = harness({ draft: 'before old after', selection: { start: 7, end: 10 } })
    await h.controller.start(h.snapshot(), context)
    h.sync()
    h.controller.undo()
    h.sync()
    h.setInput({ ...h.input(), selection: { start: 11, end: 16 } })
    h.sync()

    await h.controller.start(h.snapshot(), context)

    expect(h.input().draft).toBe('before old optimized')
    expect(h.generate).toHaveBeenCalledTimes(2)
    expect(h.writer.replacements.at(-1)?.selection).toEqual({
      sessionId: session('a'), draftRev: 3, start: 11, end: 16,
    })
  })

  it('invalidates reuse when the restored source is edited', async () => {
    const h = harness()
    await h.controller.start(h.snapshot(), context)
    h.sync()
    h.controller.undo()
    h.sync()
    h.edit('edited source')

    await h.controller.start(h.snapshot(), context)
    expect(h.generate).toHaveBeenCalledTimes(2)
    expect(h.input().draft).toBe('optimized')
  })

  it('invalidates undo and reuse when the optimized text is edited', async () => {
    const h = harness()
    await h.controller.start(h.snapshot(), context)
    h.sync()
    h.edit('optimized with an edit')

    expect(h.controller.undo()).toBe(false)
    expect(h.input().draft).toBe('optimized with an edit')
    await h.controller.start(h.snapshot(), context)
    expect(h.generate).toHaveBeenCalledTimes(2)
  })

  it('invalidates a selection cache when the optimized span is edited at its boundary', async () => {
    const h = harness({ draft: 'before old after', selection: { start: 7, end: 10 } })
    await h.controller.start(h.snapshot(), context)
    h.sync()
    h.edit('before optimizedX after')

    expect(h.controller.undo()).toBe(false)
    expect(h.input().draft).toBe('before optimizedX after')
  })

  it('does not request blank drafts or automatically request on sync', async () => {
    const h = harness({ draft: ' \n\t ' })
    h.sync()
    await h.controller.start(h.snapshot(), context)

    expect(h.generate).not.toHaveBeenCalled()
    expect(h.writer.replacements).toEqual([])
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: null })
  })

  it('preserves the draft after failure and permits only manual retry', async () => {
    const generate = vi.fn()
      .mockRejectedValueOnce(new Error('provider secret'))
      .mockImplementationOnce(async (request: OptimizeRequest): Promise<AuxiliaryResult> => ({
        requestId: request.requestId, text: 'retry worked', route: { provider: 'p', model: 'm' },
      }))
    const h = harness({ generate })

    await h.controller.start(h.snapshot(), context)
    expect(h.input().draft).toBe('source')
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: 'MODEL_FAILED' })
    expect(generate).toHaveBeenCalledTimes(1)
    h.sync()
    expect(generate).toHaveBeenCalledTimes(1)

    await h.controller.start(h.snapshot(), context)
    expect(generate).toHaveBeenCalledTimes(2)
    expect(h.input().draft).toBe('retry worked')
    expect(h.controller.getSnapshot()).toEqual({ status: 'undo', error: null })
  })

  it('retains an auxiliary error category until the draft changes', async () => {
    const h = harness({ generate: async () => { throw new AuxiliaryError('SESSION_CHANGED') } })

    await h.controller.start(h.snapshot(), context)
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: 'SESSION_CHANGED' })

    h.edit('edited source')
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: null })
  })

  it('keeps the editor writable and coalesces repeated clicks while pending', async () => {
    const pending = deferred<AuxiliaryResult>()
    const h = harness({ generate: () => pending.promise })
    const started = h.controller.start(h.snapshot(), context)
    h.edit('source plus typing')

    await h.controller.start(h.snapshot(), context)
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.input().draft).toBe('source plus typing')
    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'late', route: { provider: 'p', model: 'm' } })
    await started
    expect(h.input().draft).toBe('source plus typing')
    expect(h.controller.getSnapshot().status).toBe('optimize')
  })

  it('drops a full-draft response when text is appended without a revision change', async () => {
    const pending = deferred<AuxiliaryResult>()
    const h = harness({ generate: () => pending.promise })
    const started = h.controller.start(h.snapshot(), context)
    h.setInput({ ...h.input(), draft: 'source appended' })
    h.sync()

    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'stale', route: { provider: 'p', model: 'm' } })
    await started
    expect(h.input().draft).toBe('source appended')
    expect(h.writer.replacements).toEqual([])
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: null })
  })

  it.each([
    ['session', { sessionId: session('b'), draftRev: 1, draft: 'source' }],
    ['revision', { sessionId: session('a'), draftRev: 2, draft: 'source' }],
    ['span', { sessionId: session('a'), draftRev: 1, draft: 'drifted' }],
  ])('drops a late response after %s changes', async (_name, changed) => {
    const pending = deferred<AuxiliaryResult>()
    const h = harness({ generate: () => pending.promise })
    const started = h.controller.start(h.snapshot(), context)
    h.setInput({ ...h.input(), ...changed })
    h.sync()

    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'stale', route: { provider: 'p', model: 'm' } })
    await started
    expect(h.input().draft).toBe(changed.draft)
    expect(h.writer.replacements).toEqual([])
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: null })
  })

  it('drops a response whose requestId does not match the click', async () => {
    const h = harness({ generate: async () => ({ requestId: 'older-request', text: 'stale', route: { provider: 'p', model: 'm' } }) })
    await h.controller.start(h.snapshot(), context)

    expect(h.input().draft).toBe('source')
    expect(h.writer.replacements).toEqual([])
    expect(h.controller.getSnapshot().status).toBe('optimize')
  })

  it('does not overwrite the optimized text when undo CAS fails', async () => {
    const h = harness()
    await h.controller.start(h.snapshot(), context)
    h.sync()
    h.writer.acceptReplace = false

    expect(h.controller.undo()).toBe(false)
    expect(h.input().draft).toBe('optimized')
  })

  it.each(['dispose', 'module'] as const)('aborts on %s and ignores a late result', async close => {
    const pending = deferred<AuxiliaryResult>()
    let signal!: AbortSignal
    const h = harness({ generate: (_request, requestSignal) => {
      signal = requestSignal
      return pending.promise
    } })
    const started = h.controller.start(h.snapshot(), context)

    if (close === 'dispose') h.controller.dispose()
    else h.controller.setEnabled(false)
    expect(signal.aborted).toBe(true)
    pending.resolve({ requestId: h.generate.mock.calls[0]![0].requestId, text: 'late', route: { provider: 'p', model: 'm' } })
    await started

    expect(h.input().draft).toBe('source')
    expect(h.writer.replacements).toEqual([])
    expect(h.controller.getSnapshot()).toEqual({ status: 'optimize', error: null })
  })

  it('reuses Host and source segments through structured optimize, undo, and cached re-optimization', async () => {
    const occurrences: readonly Occurrence[] = [
      { occurrenceId: 1, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x' },
      { occurrenceId: 2, source: 'file', ref: 'y', offset: 5, length: 2, label: 'y', clipboardText: '@y' },
    ]
    const h = harness({
      draft: 'a@x b@y c', occurrences,
      generate: async (request): Promise<AuxiliaryResult> => ({
        requestId: request.requestId, text: 'A@x B@y C', segments: ['A', ' B', ' C'],
        route: { provider: 'p', model: 'm' },
      }),
    })

    await h.controller.start(h.snapshot(), context)

    expect(h.generate.mock.calls[0]?.[0].references).toEqual([
      { offset: 1, length: 2, text: '@x' },
      { offset: 5, length: 2, text: '@y' },
    ])
    expect(h.input().draft).toBe('A@x B@y C')
    expect(h.writer.replacements).toHaveLength(1)
    expect(h.writer.replacements[0]).toMatchObject({
      segments: ['A', ' B', ' C'],
      selection: { structured: true, occurrences, start: 0, end: 9 },
    })
    h.sync()

    expect(h.controller.undo()).toBe(true)
    expect(h.input().draft).toBe('a@x b@y c')
    expect(h.writer.replacements.at(-1)).toMatchObject({ segments: ['a', ' b', ' c'] })
    h.sync()
    await h.controller.start(h.snapshot(), context)

    expect(h.input().draft).toBe('A@x B@y C')
    expect(h.writer.replacements.at(-1)).toMatchObject({ segments: ['A', ' B', ' C'] })
    expect(h.generate).toHaveBeenCalledTimes(1)
    expect(h.writer.replacements).toHaveLength(3)
  })

  it('does not write a structured response without Host-validated segments', async () => {
    const h = harness({
      draft: 'a@x c',
      occurrences: [{ occurrenceId: 1, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x' }],
      generate: async (request): Promise<AuxiliaryResult> => ({
        requestId: request.requestId, text: 'A@x C', route: { provider: 'p', model: 'm' },
      }),
    })

    await h.controller.start(h.snapshot(), context)

    expect(h.input().draft).toBe('a@x c')
    expect(h.writer.replacements).toEqual([])
  })

  it.each(['revision', 'chip structure'] as const)('drops a structured response after %s changes', async change => {
    const occurrence: Occurrence = {
      occurrenceId: 1, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x',
    }
    const pending = deferred<AuxiliaryResult>()
    const h = harness({ draft: 'a@x c', occurrences: [occurrence], generate: () => pending.promise })
    const started = h.controller.start(h.snapshot(), context)
    h.setInput(change === 'revision'
      ? { ...h.input(), draftRev: 2 }
      : { ...h.input(), occurrences: [{ ...occurrence, occurrenceId: 99 }] })
    h.sync()

    pending.resolve({
      requestId: h.generate.mock.calls[0]![0].requestId,
      text: 'A@x C', segments: ['A', ' C'], route: { provider: 'p', model: 'm' },
    })
    await started

    expect(h.input().draft).toBe('a@x c')
    expect(h.writer.replacements).toEqual([])
  })
})
