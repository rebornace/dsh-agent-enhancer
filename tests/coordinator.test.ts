import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { Coordinator } from '../src/client/composer/coordinator.ts'
import type {
  DraftGuard,
  DraftSelection,
  DraftWriter,
  KeyContext,
  ModuleSwitches,
  Occurrence,
} from '../src/client/composer/types.ts'

const session = (value: string): SessionId => value as SessionId

function key(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    composing: false,
    systemLayerOpen: false,
    officialMenuOpen: false,
    atFirstLine: true,
    atLastLine: true,
    ...overrides,
  }
}

class Writer implements DraftWriter {
  readonly replacements: Array<{ text: string; selection: DraftSelection }> = []
  readonly drafts: Array<{ text: string; caret: number }> = []
  acceptReplace = true

  replace(text: string, selection: DraftSelection): boolean {
    this.replacements.push({ text, selection })
    return this.acceptReplace
  }

  setDraft(text: string, caret: number): void {
    this.drafts.push({ text, caret })
  }
}

interface SetupOptions {
  draft?: string
  occurrences?: readonly Occurrence[]
  history?: (sessionId: SessionId) => readonly { seq: number; text: string }[] | Promise<readonly { seq: number; text: string }[]>
}

function setup(options: SetupOptions = {}) {
  const writer = new Writer()
  const switches = { history: true, optimize: true, predict: true }
  const moduleSwitches: ModuleSwitches = {
    history: () => switches.history,
    optimize: () => switches.optimize,
    predict: () => switches.predict,
  }
  const coordinator = new Coordinator(writer, moduleSwitches, () => 100)
  const input = {
    sessionId: session('a'),
    draft: options.draft ?? '',
    draftRev: 1,
    selection: { start: 0, end: 0 },
    occurrences: options.occurrences ?? [],
    running: false,
  }
  coordinator.sync(input)
  if (options.history) coordinator.registerHistory({ load: options.history })
  return { coordinator, writer, switches, input }
}

function guard(input: { sessionId: SessionId; draftRev: number }): DraftGuard {
  return { sessionId: input.sessionId, draftRev: input.draftRev }
}

describe('Coordinator key priority', () => {
  it('leaves IME, system layers, and official menus untouched', () => {
    const { coordinator } = setup()
    coordinator.showPrediction({ text: '下一句', guard: guard({ sessionId: session('a'), draftRev: 1 }) })

    expect(coordinator.handleKey('up', key({ composing: true }))).toBe(false)
    expect(coordinator.handleKey('tab', key({ systemLayerOpen: true }))).toBe(false)
    expect(coordinator.handleKey('tab', key({ officialMenuOpen: true }))).toBe(false)
    expect(coordinator.handleKey('escape', key({ systemLayerOpen: true }))).toBe(false)
    expect(coordinator.handleKey('tab', key())).toBe(true)
  })

  it('does not take vertical keys away from multi-line editing', () => {
    const { coordinator } = setup({ history: () => [{ seq: 1, text: 'old' }] })
    expect(coordinator.handleKey('up', key({ atFirstLine: false }))).toBe(false)
    expect(coordinator.handleKey('down', key({ atLastLine: false }))).toBe(false)
  })

  it('ignores keys and late history callbacks after dispose', async () => {
    let finish!: (entries: readonly { seq: number; text: string }[]) => void
    const pending = new Promise<readonly { seq: number; text: string }[]>(resolve => { finish = resolve })
    const { coordinator, writer } = setup({ history: () => pending })
    expect(coordinator.handleKey('up', key())).toBe(true)
    coordinator.dispose()
    finish([{ seq: 1, text: 'late' }])
    await pending

    expect(coordinator.handleKey('up', key())).toBe(false)
    expect(coordinator.handleKey('escape', key())).toBe(false)
    expect(writer.replacements).toEqual([])
  })
})

describe('Coordinator prediction and optimization guards', () => {
  it('shows a prediction only for the current empty draft', () => {
    const { coordinator, input } = setup()
    expect(coordinator.showPrediction({ text: 'stale', guard: { sessionId: session('b'), draftRev: 1 } })).toBe(false)
    expect(coordinator.showPrediction({ text: 'stale', guard: { sessionId: input.sessionId, draftRev: 0 } })).toBe(false)
    expect(coordinator.showPrediction({ text: '下一句', guard: guard(input) })).toBe(true)
    coordinator.sync({ ...input, draft: 'typed' })
    expect(coordinator.showPrediction({ text: 'another', guard: guard(input) })).toBe(false)
  })

  it('accepts Tab into the draft without submitting', () => {
    const { coordinator, writer, input } = setup()
    coordinator.showPrediction({ text: '下一句', guard: guard(input) })

    expect(coordinator.handleKey('enter', key())).toBe(false)
    expect(coordinator.handleKey('tab', key())).toBe(true)
    expect(writer.drafts).toEqual([{ text: '下一句', caret: 3 }])
    expect(writer.replacements).toEqual([])
    expect(coordinator.handleKey('tab', key())).toBe(false)
  })

  it('rejects stale predictions after external edits, session changes, and disposal', () => {
    const { coordinator, input } = setup()
    expect(coordinator.showPrediction({ text: 'one', guard: guard(input) })).toBe(true)
    coordinator.sync({ ...input, draftRev: 2 })
    expect(coordinator.handleKey('tab', key())).toBe(false)

    expect(coordinator.showPrediction({ text: 'two', guard: guard({ ...input, draftRev: 2 }) })).toBe(true)
    coordinator.sync({ ...input, sessionId: session('b'), draftRev: 1 })
    expect(coordinator.handleKey('tab', key())).toBe(false)

    const current = { sessionId: session('b'), draftRev: 1 }
    expect(coordinator.showPrediction({ text: 'three', guard: current })).toBe(true)
    coordinator.dispose()
    expect(coordinator.handleKey('tab', key())).toBe(false)
  })

  it('requires every replace guard field and never falls back to setDraft', () => {
    const { coordinator, writer, input } = setup({ draft: 'source' })
    coordinator.sync({ ...input, selection: { start: 1, end: 3 } })
    writer.acceptReplace = false

    expect(coordinator.applyOptimization({ text: 'better', guard: guard(input) })).toBe(false)
    expect(writer.replacements).toEqual([{
      text: 'better',
      selection: { sessionId: input.sessionId, draftRev: 1, start: 1, end: 3 },
    }])
    expect(writer.drafts).toEqual([])
    expect(coordinator.applyOptimization({ text: 'wrong session', guard: { sessionId: session('b'), draftRev: 1 } })).toBe(false)
    expect(coordinator.applyOptimization({ text: 'wrong rev', guard: { sessionId: input.sessionId, draftRev: 2 } })).toBe(false)
  })

  it('drops an optimization response when its module was switched off', () => {
    const { coordinator, writer, switches, input } = setup({ draft: 'source' })
    switches.optimize = false
    expect(coordinator.applyOptimization({ text: 'late', guard: guard(input) })).toBe(false)
    expect(writer.replacements).toEqual([])
    expect(writer.drafts).toEqual([])
  })

  it('tracks and undoes an optimization that replaces only the current selection', () => {
    const { coordinator, writer, input } = setup({ draft: 'old middle' })
    coordinator.sync({ ...input, selection: { start: 0, end: 3 } })
    expect(coordinator.applyOptimization({ text: 'new', guard: guard(input) })).toBe(true)
    coordinator.sync({ ...input, draft: 'new middle', draftRev: 2, selection: { start: 3, end: 3 } })

    expect(coordinator.handleKey('escape', key())).toBe(true)
    expect(writer.replacements.at(-1)).toEqual({
      text: 'old',
      selection: { sessionId: input.sessionId, draftRev: 2, start: 0, end: 3 },
    })
  })

  it('keeps only its own optimized write and invalidates it on external edits', () => {
    const { coordinator, writer, input } = setup({ draft: 'source' })
    coordinator.sync({ ...input, selection: { start: 0, end: 6 } })
    expect(coordinator.applyOptimization({ text: 'better', guard: guard(input) })).toBe(true)
    coordinator.sync({ ...input, draft: 'better', draftRev: 2, selection: { start: 6, end: 6 } })
    expect(coordinator.handleKey('escape', key())).toBe(true)
    expect(writer.replacements.at(-1)).toEqual({
      text: 'source',
      selection: { sessionId: input.sessionId, draftRev: 2, start: 0, end: 6 },
    })

    coordinator.sync({ ...input, draft: 'source', draftRev: 3, selection: { start: 0, end: 6 } })
    expect(coordinator.applyOptimization({ text: 'again', guard: { sessionId: input.sessionId, draftRev: 3 } })).toBe(true)
    coordinator.sync({ ...input, draft: 'external', draftRev: 4 })
    expect(coordinator.handleKey('escape', key())).toBe(false)
  })

  it('does not Escape-undo when reordered chips arrive with the expected optimized draft', () => {
    const occurrences: readonly Occurrence[] = [
      { occurrenceId: 7, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x' },
      { occurrenceId: 9, source: 'file', ref: 'y', offset: 5, length: 2, label: 'y', clipboardText: '@y' },
    ]
    const { coordinator, writer, input } = setup({ draft: 'a@x b@y c', occurrences })
    const selection: DraftSelection = {
      sessionId: input.sessionId, draftRev: 1, start: 0, end: 9, structured: true, occurrences,
    }
    expect(coordinator.applyOptimization({
      text: 'A@x B@y C', guard: guard(input), source: 'a@x b@y c', selection, fullDraft: true,
      segments: ['A', ' B', ' C'], sourceSegments: ['a', ' b', ' c'],
    })).toBe(true)
    coordinator.sync({
      ...input,
      draft: 'A@x B@y C',
      draftRev: 2,
      occurrences: [{ ...occurrences[1]!, offset: 1 }, { ...occurrences[0]!, offset: 5 }],
    })

    expect(coordinator.handleKey('escape', key())).toBe(false)
    expect(writer.replacements).toHaveLength(1)
  })
})

describe('Coordinator history and search lifecycle', () => {
  it('navigates history, restores the original draft, and never submits on Enter', () => {
    const { coordinator, writer, input } = setup({
      draft: 'current',
      history: () => [{ seq: 1, text: 'older' }, { seq: 2, text: 'newer' }],
    })
    expect(coordinator.handleKey('up', key())).toBe(true)
    expect(writer.replacements.at(-1)?.text).toBe('newer')
    coordinator.sync({ ...input, draft: 'newer', draftRev: 2 })

    expect(coordinator.handleKey('up', key())).toBe(true)
    expect(writer.replacements.at(-1)?.text).toBe('older')
    expect(coordinator.handleKey('enter', key())).toBe(false)
    expect(coordinator.handleKey('down', key())).toBe(true)
    expect(writer.replacements.at(-1)?.text).toBe('newer')
    expect(coordinator.handleKey('down', key())).toBe(true)
    expect(writer.drafts).toEqual([{ text: 'current', caret: 0 }])
    expect(coordinator.handleKey('enter', key())).toBe(false)
  })

  it('restores the original caret on Escape and rejects navigation after an external edit', () => {
    const { coordinator, writer, input } = setup({
      draft: 'current draft',
      history: () => [{ seq: 1, text: 'older' }],
    })
    coordinator.sync({ ...input, selection: { start: 3, end: 8 } })
    coordinator.handleKey('up', key())
    coordinator.sync({ ...input, draft: 'older', draftRev: 2, selection: { start: 5, end: 5 } })

    expect(coordinator.handleKey('escape', key())).toBe(true)
    expect(writer.drafts).toEqual([{ text: 'current draft', caret: 8 }])

    coordinator.handleKey('up', key())
    coordinator.sync({ ...input, draft: 'older', draftRev: 3 })
    coordinator.sync({ ...input, draft: 'user edit', draftRev: 4 })
    expect(coordinator.handleKey('down', key())).toBe(false)
    expect(coordinator.handleKey('escape', key())).toBe(false)
    expect(writer.drafts).toHaveLength(1)
  })

  it('invalidates a history snapshot when a menu opens or a new turn starts', () => {
    const { coordinator, writer, input } = setup({
      draft: 'draft',
      history: () => [{ seq: 1, text: 'old' }],
    })
    coordinator.handleKey('up', key())
    coordinator.sync({ ...input, draft: 'old', draftRev: 2 })
    expect(coordinator.handleKey('down', key({ officialMenuOpen: true }))).toBe(false)
    expect(coordinator.handleKey('escape', key())).toBe(false)

    coordinator.handleKey('up', key())
    coordinator.sync({ ...input, draft: 'old', draftRev: 3 })
    coordinator.sync({ ...input, draft: 'old', draftRev: 3, running: true })
    expect(coordinator.handleKey('escape', key())).toBe(false)
    expect(writer.drafts).toEqual([])
  })

  it('searches case-insensitively and accepts mouse and keyboard candidates through one guarded action', () => {
    const { coordinator, writer, input } = setup({
      draft: 'keep',
      history: () => [{ seq: 1, text: 'Needle one' }, { seq: 2, text: 'other' }, { seq: 1, text: 'duplicate' }],
    })
    expect(coordinator.handleKey('search', key())).toBe(true)
    expect(coordinator.updateSearch('needle')).toBe(true)
    expect(coordinator.acceptHistory({ seq: 1, text: 'Needle one' }, guard(input))).toBe(true)
    expect(writer.drafts).toEqual([{ text: 'Needle one', caret: 10 }])

    coordinator.handleKey('search', key())
    expect(coordinator.acceptHistory({ seq: 1, text: 'Needle one' }, guard({ ...input, draftRev: 0 }))).toBe(false)
    expect(coordinator.handleKey('enter', key())).toBe(true)
    expect(writer.drafts).toEqual([
      { text: 'Needle one', caret: 10 },
      { text: 'other', caret: 5 },
    ])
  })

  it('invalidates an in-flight history load on an external draft revision', async () => {
    let finish!: (entries: readonly { seq: number; text: string }[]) => void
    const pending = new Promise<readonly { seq: number; text: string }[]>(resolve => { finish = resolve })
    const { coordinator, writer, input } = setup({ history: () => pending })
    expect(coordinator.handleKey('up', key())).toBe(true)
    coordinator.sync({ ...input, draft: 'external', draftRev: 2 })
    finish([{ seq: 1, text: 'late' }])
    await pending
    await Promise.resolve()

    expect(writer.replacements).toEqual([])
    expect(coordinator.handleKey('escape', key())).toBe(false)
  })

  it('does not let an old history load overwrite a newer search interaction', async () => {
    let finish!: (entries: readonly { seq: number; text: string }[]) => void
    const pending = new Promise<readonly { seq: number; text: string }[]>(resolve => { finish = resolve })
    const { coordinator, writer } = setup({ history: () => pending })
    expect(coordinator.handleKey('up', key())).toBe(true)
    expect(coordinator.handleKey('search', key())).toBe(true)
    finish([{ seq: 1, text: 'stale history' }])
    await pending
    await Promise.resolve()

    expect(writer.replacements).toEqual([])
    expect(coordinator.updateSearch('')).toBe(true)
  })

  it('filters a late search load with the latest query before accepting Enter', async () => {
    let finish!: (entries: readonly { seq: number; text: string }[]) => void
    const pending = new Promise<readonly { seq: number; text: string }[]>(resolve => { finish = resolve })
    const { coordinator, writer } = setup({ history: () => pending })
    expect(coordinator.handleKey('search', key())).toBe(true)
    expect(coordinator.updateSearch('needle')).toBe(true)
    finish([{ seq: 2, text: 'other' }, { seq: 1, text: 'needle' }])
    await pending
    await Promise.resolve()

    expect(coordinator.handleKey('enter', key())).toBe(true)
    expect(writer.drafts).toEqual([{ text: 'needle', caret: 6 }])
  })

  it('retains another session history cache while clearing transient state', () => {
    const loads: SessionId[] = []
    const entries = [{ seq: 1, text: 'cached' }]
    const { coordinator, input } = setup({
      history: id => { loads.push(id); return entries },
    })
    coordinator.handleKey('up', key())
    coordinator.sync({ ...input, sessionId: session('b'), draftRev: 4 })
    expect(coordinator.handleKey('escape', key())).toBe(false)
    coordinator.sync({ ...input, sessionId: session('a'), draftRev: 5 })
    coordinator.handleKey('up', key())

    expect(loads).toEqual([session('a')])
  })

  it('uses Escape for transient state before search and adopts a candidate only with Enter', () => {
    const { coordinator, writer } = setup({ history: () => [{ seq: 1, text: 'needle' }] })
    expect(coordinator.handleKey('search', key())).toBe(true)
    expect(coordinator.updateSearch('need')).toBe(true)
    expect(coordinator.handleKey('enter', key())).toBe(true)
    expect(writer.drafts).toEqual([{ text: 'needle', caret: 6 }])

    expect(coordinator.handleKey('search', key())).toBe(true)
    expect(coordinator.handleKey('escape', key())).toBe(true)
    expect(coordinator.handleKey('escape', key())).toBe(false)
    expect(writer.drafts).toEqual([
      { text: 'needle', caret: 6 },
      { text: 'needle', caret: 6 },
    ])
  })

  it('honors history and prediction switches at action time', () => {
    const { coordinator, switches, input } = setup({ history: () => [{ seq: 1, text: 'old' }] })
    switches.history = false
    switches.predict = false
    expect(coordinator.handleKey('search', key())).toBe(false)
    expect(coordinator.handleKey('up', key())).toBe(false)
    expect(coordinator.showPrediction({ text: 'off', guard: guard(input) })).toBe(false)
  })
})
