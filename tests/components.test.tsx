// @vitest-environment jsdom
import type { InputActions, InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuxiliaryRequest, AuxiliaryResult } from '../src/host/types.ts'
import { PromptSession } from '../src/client/prompt/session.ts'
import type { Coordinator } from '../src/client/prompt/coordinator.ts'
import { AgentControls } from '../src/client/dsh/controls.tsx'
import type { AgentOverlayProps } from '../src/client/dsh/overlay.tsx'
import { AgentOverlay } from '../src/client/dsh/overlay.tsx'
import { readSelection, restoreSelection } from '../src/client/dsh/editor.ts'
import { OverlapHintStore } from '../src/client/dsh/plugin-hints.ts'
import { CoexistenceHints } from '../src/client/dsh/hints.tsx'
import { PluginSettings } from '../src/client/dsh/settings.tsx'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { resolveSettings } from '../src/config.ts'
import type { EnhancerSettings } from '../src/config.ts'
import { AuxiliaryError } from '../src/errors.ts'

const translations: Record<string, string> = {
  historyTitle: 'Prompt history',
  historySearch: 'Search prompt history',
  historyResults: 'Prompt history results',
  historyClose: 'Close prompt history',
  optimize: 'Optimize prompt',
  optimizePending: 'Optimizing prompt',
  optimizeUndo: 'Undo optimization',
  optimizeError: 'Optimization failed. Try again.',
  optimizeModelUnavailable: 'Model unavailable. Check the model selection.',
  optimizeRequestFailed: 'Optimization failed. Try again.',
  optimizeInvalidOutput: 'The model response cannot be applied safely. Try again.',
  optimizeRollbackFailed: 'Draft recovery failed. Check the draft and restore it manually.',
  optimizeSessionChanged: 'Session changed. Optimize again.',
  optimizeChips: 'Optimization is unavailable with references',
  optimizeChipSelection: 'Selection includes references. Optimize the full draft or adjust the selection.',
  settingsTitle: 'Agent Enhance',
  settingsSubtitle: 'Toggle input helpers as needed',
  history: 'Prompt history',
  historyDescription: '↑↓ revisit sent prompts; Alt+R to search (Ctrl+R in compatible environments)',
  optimizeDescription: 'Optimize the draft or selection, with one-click undo',
  predict: 'Next-prompt prediction',
  predictDescription: 'One suggestion after a reply; Tab to accept',
  modelCatalogLoading: 'Loading…',
  modelCatalogError: 'Unavailable',
  modelLabel: 'Model',
  modelFollowSession: 'Follow session',
  reasoningDefault: 'Default',
  rollback: 'Conversation and file rollback',
  rollbackDescription: 'Preview and restore conversation and tracked files at eligible turn boundaries',
  contextInspect: 'Context details',
  contextInspectDescription: 'Click System / Tools / Messages on the official context meter to open details in the right sidebar',
  rollbackBoundary: 'External process, service, and untracked-file state is not restored; logs and checkpoints remain after disable.',
  privacyTitle: 'Data and privacy',
  privacy: 'Optimization and prediction send selected text or recent conversation to the selected model provider (defaults to the current session model). History never requests a model. No prompt content or acceptance-rate telemetry is collected.',
  coexistence: 'Similar official or third-party features are only reported; they are never disabled automatically.',
  settingsError: 'Setting was not saved. Try again.',
  overlapHistory: 'Another prompt-history feature is enabled. Agent Enhance history remains enabled.',
  overlapOptimize: 'Another prompt-optimization feature is enabled. Agent Enhance optimization remains enabled.',
  overlapPredict: 'Another reply-suggestion feature is enabled. Agent Enhance prediction remains enabled.',
  dismissHint: 'Dismiss coexistence notice',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

function chatFixture(): ChatSnapshot {
  const entries = [
    { key: 'u1', seq: 1, text: 'Needle one' },
    { key: 'u2', seq: 2, text: 'Other prompt' },
  ]
  const nodes = new Map(entries.map(entry => [entry.key, {
    kind: 'user',
    data: { seq: entry.seq, content: [{ type: 'text', text: entry.text }] },
  }]))
  return {
    order: entries.map(entry => entry.key),
    nodes: { get: (key: string) => nodes.get(key) },
  } as unknown as ChatSnapshot
}

function settledChatFixture(turn = 1): ChatSnapshot {
  const nodes = new Map<string, object>([
    ['user', {
      kind: 'user',
      location: { kind: 'turn', turn: { turn } },
      data: { seq: turn, content: [{ type: 'text', text: turn === 1 ? 'first prompt' : `prompt ${turn}` }] },
    }],
    ['tail', {
      kind: 'turn-tail',
      data: {
        turn,
        closing: { status: 'settled', blocks: [{ kind: 'text', text: turn === 1 ? 'first response' : `response ${turn}` }] },
      },
    }],
  ])
  return {
    order: ['user', 'tail'],
    nodes: { get: (key: string) => nodes.get(key) },
  } as unknown as ChatSnapshot
}

function settingsHarness(
  set: ConfigForm<EnhancerSettings>['set'] = async () => true,
  initial: Partial<EnhancerSettings> = {},
  loadCatalog?: () => Promise<ModelCatalog>,
) {
  let snapshot: ConfigFormSnapshot<EnhancerSettings> = {
    status: 'ready',
    value: {
      historyEnabled: true,
      optimizeEnabled: true,
      predictEnabled: true,
      rollbackEnabled: true,
      contextInspectEnabled: true,
      optimizeProvider: '',
      optimizeModel: '',
      optimizeReasoningEffort: '',
      predictProvider: '',
      predictModel: '',
      predictReasoningEffort: '',
      compactProvider: '',
      compactModel: '',
      compactReasoningEffort: '',
      ...initial,
    },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
  }
  const listeners = new Set<() => void>()
  const form: ConfigForm<EnhancerSettings> = {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set,
    unset: async () => true,
    mutate: async () => true,
  }
  const t = (key: string) => translations[key] ?? key
  const view = render(<PluginSettings form={form} t={t} loadCatalog={loadCatalog} />)
  return {
    form,
    view,
    listeners,
    accept(value: Partial<EnhancerSettings>, writable = true) {
      act(() => {
        snapshot = {
          ...snapshot,
          value: resolveSettings({ ...snapshot.value, ...value }),
          writable,
          revision: (snapshot.revision ?? 0) + 1,
        }
        for (const listener of listeners) listener()
      })
    },
  }
}

const sessions: PromptSession[] = []

type Occurrence = InputState['occurrences'][number]

interface SetupViewOptions {
  readonly draft?: string
  readonly chat?: ChatSnapshot
  readonly failWrites?: readonly number[]
}

function setup(
  occurrences: readonly Occurrence[] = [],
  implementation?: (request: AuxiliaryRequest, signal: AbortSignal) => Promise<AuxiliaryResult | null>,
  viewOptions: SetupViewOptions = {},
) {
  const card = document.createElement('div')
  card.dataset.composerCard = ''
  const root = document.createElement('div')
  root.dataset.composerInput = ''
  root.contentEditable = 'true'
  const initialDraft = viewOptions.draft ?? 'original draft'
  root.innerHTML = `<p>${initialDraft}</p>`
  const host = document.createElement('div')
  card.append(root, host)
  document.body.append(card)
  let input: { draft: string; draftRev: number; occurrences: readonly Occurrence[] } = {
    draft: initialDraft,
    draftRev: 1,
    occurrences,
  }
  const detectProjection = (draft: string, current: readonly Occurrence[]): string => {
    let result = ''
    let start = 0
    for (const occurrence of current) {
      result += draft.slice(start, occurrence.offset) + '\uFFFC'
      start = occurrence.offset + occurrence.length
    }
    return result + draft.slice(start)
  }
  let detectDraft = detectProjection(initialDraft, occurrences)
  const clipboardOffset = (offset: number): number => {
    let result = offset
    let expansion = 0
    for (const occurrence of input.occurrences) {
      if (offset <= occurrence.offset - expansion) break
      result += occurrence.length - 1
      expansion += occurrence.length - 1
    }
    return result
  }
  let persists = 0
  let submits = 0
  let setDrafts = 0
  const spans: Array<{ text: string; start: number; end: number; draftRev: number }> = []
  const actions = {
    captureInsertion: () => ({ start: 0, end: detectDraft.length, draftRev: input.draftRev }),
    insertText: (text: string, selection: { start: number; end: number; draftRev: number }) => {
      spans.push({ text, ...selection })
      if (viewOptions.failWrites?.includes(spans.length) || selection.draftRev !== input.draftRev || selection.start < 0 ||
        selection.end < selection.start || selection.end > detectDraft.length) return false
      const clipboardStart = clipboardOffset(selection.start)
      const clipboardEnd = clipboardOffset(selection.end)
      const draft = input.draft.slice(0, clipboardStart) + text + input.draft.slice(clipboardEnd)
      const delta = text.length - (clipboardEnd - clipboardStart)
      input = {
        ...input,
        draft,
        draftRev: input.draftRev + 1,
        occurrences: input.occurrences.map(occurrence => occurrence.offset >= clipboardStart
          ? { ...occurrence, offset: occurrence.offset + delta }
          : occurrence),
      }
      detectDraft = detectDraft.slice(0, selection.start) + text + detectDraft.slice(selection.end)
      root.innerHTML = `<p>${draft}</p>`
      return true
    },
    setDraft: (text: string) => {
      setDrafts += 1
      input = { ...input, draft: text, draftRev: input.draftRev + 1, occurrences: [] }
      detectDraft = text
      root.innerHTML = `<p>${text}</p>`
    },
    persistDraft: () => { persists += 1 },
    submit: () => { submits += 1 },
  } as unknown as InputActions
  let chat = viewOptions.chat ?? chatFixture()
  const switches = { history: true, optimize: true, predict: true }
  const generate = vi.fn(implementation ?? (async (request: AuxiliaryRequest): Promise<AuxiliaryResult> => ({
    requestId: request.requestId, text: 'optimized draft', route: { provider: 'p', model: 'm' },
  })))
  const composer = new PromptSession({
    history: () => switches.history,
    optimize: () => switches.optimize,
    predict: () => switches.predict,
  }, generate, generate)
  sessions.push(composer)
  const props = {
    sessionId: 'session-1' as SessionId,
    session: composer,
    inputActions: actions,
    useInput: (selector: (value: typeof input) => unknown) => selector(input),
    useSession: (selector: (value: { running: boolean }) => unknown) => selector({ running: false }),
    useConversation: (selector: (value: { views: Map<string, ChatSnapshot> }) => unknown) =>
      selector({ views: new Map([['chat', chat]]) }),
    t: (key: string) => translations[key] ?? key,
  } as unknown as AgentOverlayProps
  const content = () => <>
    <AgentControls session={composer} t={props.t} />
    <AgentOverlay {...props} />
  </>
  const view = render(content(), { container: host })
  const initialCaret = viewOptions.draft === undefined ? 8 : initialDraft.length
  restoreSelection(root, { start: initialCaret, end: initialCaret })
  return {
    root,
    view,
    generate,
    switches,
    spans,
    session: composer,
    coordinator: (composer as unknown as { coordinator: Coordinator }).coordinator,
    failWrites: (next: readonly number[]) => { viewOptions = { ...viewOptions, failWrites: next } },
    input: () => input,
    persists: () => persists,
    submits: () => submits,
    setDrafts: () => setDrafts,
    select: (start: number, end: number) => {
      restoreSelection(root, { start, end })
      fireEvent(document, new Event('selectionchange'))
    },
    changeOccurrences: (next: readonly Occurrence[]) => {
      input = { ...input, occurrences: next }
      view.rerender(content())
    },
    refreshInput: () => {
      composer.refreshSettings()
      view.rerender(content())
    },
    refreshChat: (next: ChatSnapshot) => {
      chat = next
      view.rerender(content())
    },
    editDraft: (draft: string) => {
      input = { ...input, draft, draftRev: input.draftRev + 1 }
      root.innerHTML = `<p>${draft}</p>`
      fireEvent.input(root)
      view.rerender(content())
    },
  }
}

afterEach(() => {
  cleanup()
  for (const session of sessions.splice(0)) session.dispose()
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
})

describe('AgentControls prompt optimization', () => {
  it('keeps one accessible button through optimize, pending, undo, and cached reuse', async () => {
    const pending = deferred<AuxiliaryResult>()
    const { root, generate, refreshInput } = setup([], () => pending.promise)
    const button = screen.getByRole('button', { name: 'Optimize prompt' })
    expect(button.className).toContain('ghost')
    expect(button.className).not.toContain('_toolbar_')
    expect(button.dataset.agentEnhancerIcon).toBe('optimize')
    const icon = button.querySelector('svg')
    expect(icon && {
      viewBox: icon.getAttribute('viewBox'),
      fill: icon.getAttribute('fill'),
      stroke: icon.getAttribute('stroke'),
      hidden: icon.getAttribute('aria-hidden'),
      width: icon.getAttribute('width'),
      height: icon.getAttribute('height'),
    }).toEqual({ viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', hidden: 'true', width: '16', height: '16' })
    expect(button.getAttribute('data-agent-enhancer-icon')).toBe('optimize')
    expect([...button.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent)).not.toContain('Optimize prompt')

    fireEvent.click(button)
    expect(screen.getByRole('button', { name: 'Optimizing prompt' })).toBe(button)
    expect(button.getAttribute('data-agent-enhancer-icon')).toBe('pending')
    expect(button).toHaveProperty('disabled', true)
    expect(root.textContent).toBe('original draft')
    expect(root.contentEditable).toBe('true')
    expect(generate).toHaveBeenCalledTimes(1)

    pending.resolve({ requestId: generate.mock.calls[0]![0].requestId, text: 'optimized draft', route: { provider: 'p', model: 'm' } })
    await waitFor(() => { expect(root.textContent).toBe('optimized draft') })
    refreshInput()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Undo optimization' })).toBe(button) })
    expect(button.getAttribute('data-agent-enhancer-icon')).toBe('undo')

    fireEvent.click(button)
    refreshInput()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Optimize prompt' })).toBe(button) })
    expect(root.textContent).toBe('original draft')

    fireEvent.click(button)
    await waitFor(() => { expect(root.textContent).toBe('optimized draft') })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('keeps undo enabled after an optimization returns only whitespace', async () => {
    const { root, generate, refreshInput } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: '   ', route: { provider: 'p', model: 'm' },
    }))
    const button = screen.getByRole('button', { name: 'Optimize prompt' })
    fireEvent.click(button)

    await waitFor(() => { expect(root.textContent).toBe('   ') })
    refreshInput()
    await waitFor(() => { expect(screen.getByRole('button', { name: 'Undo optimization' })).toBe(button) })
    expect(button).toHaveProperty('disabled', false)
    fireEvent.click(button)
    refreshInput()

    expect(root.textContent).toBe('original draft')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('optimizes around chips and reuses both segment arrays for undo and cached re-optimization', async () => {
    const occurrences: readonly Occurrence[] = [
      { occurrenceId: 7, source: 'file', ref: 'x', offset: 4, length: 2, label: 'x', clipboardText: '@x' },
      { occurrenceId: 9, source: 'file', ref: 'y', offset: 8, length: 2, label: 'y', clipboardText: '@y' },
    ]
    const { root, generate, refreshInput, spans, input, persists, submits, setDrafts } = setup(
      occurrences,
      async (request): Promise<AuxiliaryResult> => ({
        requestId: request.requestId,
        text: '@x ALPHA@x BETA@y TAIL',
        segments: ['@x ALPHA', ' BETA', ' TAIL'],
        route: { provider: 'p', model: 'm' },
      }),
      { draft: '@x a@x b@y c' },
    )
    const button = screen.getByRole('button', { name: 'Optimize prompt' })
    expect(button).toHaveProperty('disabled', false)

    fireEvent.click(button)
    await waitFor(() => { expect(root.textContent).toBe('@x ALPHA@x BETA@y TAIL') })

    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      source: '@x a@x b@y c',
      references: [{ offset: 4, length: 2, text: '@x' }, { offset: 8, length: 2, text: '@y' }],
    })
    expect(spans).toEqual([
      { text: ' TAIL', start: 8, end: 10, draftRev: 1 },
      { text: ' BETA', start: 5, end: 7, draftRev: 2 },
      { text: '@x ALPHA', start: 0, end: 4, draftRev: 3 },
    ])
    expect(input().occurrences.map(({ occurrenceId, ref, offset }) => ({ occurrenceId, ref, offset }))).toEqual([
      { occurrenceId: 7, ref: 'x', offset: 8 },
      { occurrenceId: 9, ref: 'y', offset: 15 },
    ])
    expect(persists()).toBe(1)
    expect(setDrafts()).toBe(0)
    expect(submits()).toBe(0)

    refreshInput()
    fireEvent.click(screen.getByRole('button', { name: 'Undo optimization' }))
    expect(root.textContent).toBe('@x a@x b@y c')
    expect(input().occurrences.map(({ occurrenceId, ref, offset }) => ({ occurrenceId, ref, offset }))).toEqual([
      { occurrenceId: 7, ref: 'x', offset: 4 },
      { occurrenceId: 9, ref: 'y', offset: 8 },
    ])
    expect(persists()).toBe(2)

    refreshInput()
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))
    await waitFor(() => { expect(root.textContent).toBe('@x ALPHA@x BETA@y TAIL') })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(persists()).toBe(3)
    expect(setDrafts()).toBe(0)
    expect(submits()).toBe(0)
  })

  it('surfaces rollback failure, preserves chips, and blocks retry on a partial draft', async () => {
    const occurrences: readonly Occurrence[] = [
      { occurrenceId: 7, source: 'file', ref: 'x', offset: 4, length: 2, label: 'x', clipboardText: '@x' },
      { occurrenceId: 9, source: 'file', ref: 'y', offset: 8, length: 2, label: 'y', clipboardText: '@y' },
    ]
    const { root, input, refreshInput } = setup(occurrences, async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId,
      text: '@x ALPHA@x BETA@y TAIL',
      segments: ['@x ALPHA', ' BETA', ' TAIL'],
      route: { provider: 'p', model: 'm' },
    }), { draft: '@x a@x b@y c', failWrites: [2, 3] })
    const button = screen.getByRole('button', { name: 'Optimize prompt' })

    fireEvent.click(button)
    await waitFor(() => { expect(root.textContent).toBe('@x a@x b@y TAIL') })

    expect(input().occurrences.map(({ occurrenceId, ref }) => ({ occurrenceId, ref }))).toEqual([
      { occurrenceId: 7, ref: 'x' },
      { occurrenceId: 9, ref: 'y' },
    ])
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Draft recovery failed. Check the draft and restore it manually.')
    expect(button).toHaveProperty('disabled', true)

    refreshInput()
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Draft recovery failed. Check the draft and restore it manually.')
    expect(button).toHaveProperty('disabled', true)
  })

  it('handles rollback failure during cached re-optimization without rejecting', async () => {
    const occurrences: readonly Occurrence[] = [
      { occurrenceId: 7, source: 'file', ref: 'x', offset: 4, length: 2, label: 'x', clipboardText: '@x' },
      { occurrenceId: 9, source: 'file', ref: 'y', offset: 8, length: 2, label: 'y', clipboardText: '@y' },
    ]
    const h = setup(occurrences, async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId,
      text: '@x ALPHA@x BETA@y TAIL',
      segments: ['@x ALPHA', ' BETA', ' TAIL'],
      route: { provider: 'p', model: 'm' },
    }), { draft: '@x a@x b@y c' })
    const button = screen.getByRole('button', { name: 'Optimize prompt' })
    fireEvent.click(button)
    await waitFor(() => { expect(h.root.textContent).toBe('@x ALPHA@x BETA@y TAIL') })
    h.refreshInput()
    fireEvent.click(screen.getByRole('button', { name: 'Undo optimization' }))
    expect(h.root.textContent).toBe('@x a@x b@y c')
    h.refreshInput()
    const base = h.spans.length
    h.failWrites([base + 2, base + 3])

    await expect(h.session.optimize()).resolves.toBeUndefined()

    expect(h.root.textContent).toBe('@x a@x b@y TAIL')
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Draft recovery failed. Check the draft and restore it manually.')
    expect(button).toHaveProperty('disabled', true)
  })

  it('handles rollback failure on Escape and keeps plain-text Escape behavior', async () => {
    const occurrences: readonly Occurrence[] = [
      { occurrenceId: 7, source: 'file', ref: 'x', offset: 4, length: 2, label: 'x', clipboardText: '@x' },
      { occurrenceId: 9, source: 'file', ref: 'y', offset: 8, length: 2, label: 'y', clipboardText: '@y' },
    ]
    const h = setup(occurrences, undefined, { draft: '@x a@x b@y c' })
    const applied = h.coordinator.applyOptimization({
      text: '@x ALPHA@x BETA@y TAIL',
      guard: { sessionId: 'session-1' as SessionId, draftRev: 1 },
      source: '@x a@x b@y c',
      selection: { sessionId: 'session-1' as SessionId, draftRev: 1, start: 0, end: 12, structured: true, occurrences },
      fullDraft: true,
      segments: ['@x ALPHA', ' BETA', ' TAIL'],
      sourceSegments: ['@x a', ' b', ' c'],
    })
    expect(applied).toBe(true)
    h.coordinator.sync({
      sessionId: 'session-1' as SessionId,
      draft: h.input().draft,
      draftRev: h.input().draftRev,
      selection: { start: 0, end: 0 },
      occurrences: h.input().occurrences,
      running: false,
    })
    const base = h.spans.length
    h.failWrites([base + 2, base + 3])

    expect(() => h.session.handleKey('escape', {
      composing: false, systemLayerOpen: false, officialMenuOpen: false, atFirstLine: true, atLastLine: true,
    })).not.toThrow()

    expect(h.root.textContent).toBe('@x ALPHA@x BETA@y c')
    expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Draft recovery failed. Check the draft and restore it manually.')
    expect(screen.getByRole('button', { name: 'Optimize prompt' })).toHaveProperty('disabled', true)
  })

  it('restores a plain optimized draft on Escape', () => {
    const { root, coordinator, session, input } = setup()
    const applied = coordinator.applyOptimization({
      text: 'optimized draft',
      guard: { sessionId: 'session-1' as SessionId, draftRev: 1 },
      source: 'original draft',
      selection: { sessionId: 'session-1' as SessionId, draftRev: 1, start: 0, end: 14 },
      fullDraft: true,
    })
    expect(applied).toBe(true)
    coordinator.sync({
      sessionId: 'session-1' as SessionId,
      draft: input().draft,
      draftRev: input().draftRev,
      selection: { start: 0, end: 0 },
      occurrences: [],
      running: false,
    })

    expect(() => session.handleKey('escape', {
      composing: false, systemLayerOpen: false, officialMenuOpen: false, atFirstLine: true, atLastLine: true,
    })).not.toThrow()

    expect(root.textContent).toBe('original draft')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Optimize prompt' })).toHaveProperty('disabled', false)
  })

  it('does not undo around a changed chip identity when the optimized text is unchanged', async () => {
    const occurrence: Occurrence = {
      occurrenceId: 7, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x',
    }
    const { root, spans, persists, changeOccurrences } = setup([occurrence], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: 'A@x C', segments: ['A', ' C'], route: { provider: 'p', model: 'm' },
    }), { draft: 'a@x c' })
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))
    await waitFor(() => { expect(root.textContent).toBe('A@x C') })
    expect(spans).toHaveLength(2)

    changeOccurrences([{ ...occurrence, occurrenceId: 99 }])
    fireEvent.click(screen.getByRole('button', { name: 'Undo optimization' }))

    expect(root.textContent).toBe('A@x C')
    expect(spans).toHaveLength(2)
    expect(persists()).toBe(1)
  })

  it('optimizes a plain-text selection inside a chip draft without sending references', async () => {
    const occurrence: Occurrence = {
      occurrenceId: 7, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x',
    }
    const { root, generate, select, setDrafts } = setup([occurrence], undefined, { draft: 'a@x b' })
    select(4, 5)
    const button = screen.getByRole('button', { name: 'Optimize prompt' })
    expect(button).toHaveProperty('disabled', false)

    fireEvent.click(button)
    await waitFor(() => { expect(root.textContent).toBe('a@x optimized draft') })

    expect(generate.mock.calls[0]?.[0]).toMatchObject({ source: 'b', references: [] })
    expect(setDrafts()).toBe(0)
  })

  it('disables only a selection intersecting a chip and performs no writes', () => {
    const occurrence: Occurrence = {
      occurrenceId: 7, source: 'file', ref: 'x', offset: 1, length: 2, label: 'x', clipboardText: '@x',
    }
    const { root, generate, select, spans, setDrafts } = setup([occurrence], undefined, { draft: 'a@x b' })
    select(0, 4)
    const button = screen.getByRole('button', { name: 'Optimize prompt' })

    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBe('Selection includes references. Optimize the full draft or adjust the selection.')
    fireEvent.click(button)
    expect(generate).not.toHaveBeenCalled()
    expect(spans).toEqual([])
    expect(setDrafts()).toBe(0)
    expect(root.textContent).toBe('a@x b')
  })

  it('shows only a localized failure and permits a manual retry', async () => {
    const { root, generate } = setup([], async () => { throw new Error('private provider response') })
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe('Optimization failed. Try again.')
    expect(status.textContent).not.toContain('private provider response')
    expect(root.textContent).toBe('original draft')
    const retry = screen.getByRole('button', { name: 'Optimize prompt' })
    expect(retry).toHaveProperty('disabled', false)
    fireEvent.click(retry)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['MODEL_UNAVAILABLE', 'Model unavailable. Check the model selection.'],
    ['MODEL_FAILED', 'Optimization failed. Try again.'],
    ['INVALID_OUTPUT', 'The model response cannot be applied safely. Try again.'],
    ['SESSION_CHANGED', 'Session changed. Optimize again.'],
  ] as const)('shows the localized category for %s without exposing error text', async (code, message) => {
    const { root } = setup([], async () => { throw new AuxiliaryError(code) })
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))

    const status = await screen.findByRole('status')
    expect(status.textContent).toBe(message)
    expect(screen.getByRole('button', { name: 'Optimize prompt' }).getAttribute('title')).toBe(message)
    expect(status.textContent).not.toContain('Auxiliary model')
    expect(root.textContent).toBe('original draft')
  })

  it('aborts a pending request and restores the entry without losing the draft across disable and re-enable', async () => {
    const pending = deferred<AuxiliaryResult>()
    const { root, generate, switches, refreshInput } = setup([], () => pending.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Optimize prompt' }))
    screen.getByRole('button', { name: 'Optimizing prompt' })
    const signal = generate.mock.calls[0]![1] as AbortSignal

    switches.optimize = false
    refreshInput()
    expect(signal.aborted).toBe(true)
    expect(screen.queryByRole('button', { name: 'Optimizing prompt' })).toBeNull()
    expect(root.textContent).toBe('original draft')

    switches.optimize = true
    refreshInput()
    expect(screen.getByRole('button', { name: 'Optimize prompt' })).toBeTruthy()
    expect(root.textContent).toBe('original draft')
    pending.resolve({ requestId: 'late', text: 'late', route: { provider: 'p', model: 'm' } })
    await Promise.resolve()
    expect(root.textContent).toBe('original draft')
  })
})

describe('AgentOverlay post-reply prediction', () => {
  it('requests the latest settled turn once and renders one polite gray suggestion', async () => {
    const { generate } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: '  next prompt  ', route: { provider: 'p', model: 'm' },
    }), { draft: '', chat: settledChatFixture() })

    await screen.findByText('next prompt')
    const prediction = document.querySelector('[data-agent-enhancer-prediction]')
    expect(prediction?.getAttribute('aria-live')).toBe('polite')
    expect(prediction?.textContent).toBe('next promptTab')
    expect(document.querySelectorAll('[data-agent-enhancer-prediction]')).toHaveLength(1)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0]?.[0]).toMatchObject({
      operation: 'predict',
      context: [{ turn: 1, prompt: 'first prompt', response: 'first response' }],
    })
  })

  it('adopts only plain Tab into the real draft and never submits', async () => {
    const { root, generate, persists, submits } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: 'next prompt', route: { provider: 'p', model: 'm' },
    }), { draft: '', chat: settledChatFixture() })
    await screen.findByText('next prompt')

    expect(fireEvent.keyDown(root, { key: 'Tab', code: 'Tab', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'Tab', code: 'Tab', isComposing: true })).toBe(true)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)
    expect(fireEvent.keyDown(root, { key: 'Tab', code: 'Tab' })).toBe(true)
    dialog.remove()
    expect(root.textContent).toBe('')

    expect(fireEvent.keyDown(root, { key: 'Tab', code: 'Tab' })).toBe(false)
    expect(root.textContent).toBe('next prompt')
    expect(readSelection(root)).toEqual({ start: 11, end: 11 })
    expect(persists()).toBe(1)
    expect(submits()).toBe(0)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-agent-enhancer-prediction]')).toBeNull()
  })

  it('clears the suggestion on the first native input without generating following characters', async () => {
    const { root, generate } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: 'next prompt', route: { provider: 'p', model: 'm' },
    }), { draft: '', chat: settledChatFixture() })
    await screen.findByText('next prompt')

    root.innerHTML = '<p>x</p>'
    fireEvent.input(root)

    expect(root.textContent).toBe('x')
    expect(document.querySelector('[data-agent-enhancer-prediction]')).toBeNull()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('clears the suggestion when an official menu opens from the keyboard', async () => {
    const { root } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: 'next prompt', route: { provider: 'p', model: 'm' },
    }), { draft: '', chat: settledChatFixture() })
    await screen.findByText('next prompt')
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)

    expect(fireEvent.keyDown(root, { key: 'Tab', code: 'Tab' })).toBe(true)
    expect(document.querySelector('[data-agent-enhancer-prediction]')).toBeNull()
  })

  it.each(['menu', 'listbox'])('cancels when an unrecognized editor keydown opens an official %s afterward', async role => {
    const { root } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: 'next prompt', route: { provider: 'p', model: 'm' },
    }), { draft: '', chat: settledChatFixture() })
    await screen.findByText('next prompt')
    const menu = document.createElement('div')
    menu.setAttribute('role', role)
    root.addEventListener('keydown', event => {
      if (event.key === 'm') document.body.append(menu)
    })

    expect(fireEvent.keyDown(root, { key: 'm', code: 'KeyM' })).toBe(true)
    expect(screen.getByRole(role)).toBe(menu)
    await waitFor(() => {
      expect(document.querySelector('[data-agent-enhancer-prediction]')).toBeNull()
    })
  })

  it('clears gray text, suppresses later turns while disabled, and resumes after re-enable', async () => {
    const { generate, switches, refreshInput, refreshChat } = setup([], async (request): Promise<AuxiliaryResult> => ({
      requestId: request.requestId, text: 'next prompt', route: { provider: 'p', model: 'm' },
    }), { draft: '', chat: settledChatFixture() })
    await screen.findByText('next prompt')

    switches.predict = false
    refreshInput()
    expect(document.querySelector('[data-agent-enhancer-prediction]')).toBeNull()
    refreshChat(settledChatFixture(2))
    await Promise.resolve()
    expect(generate).toHaveBeenCalledTimes(1)

    switches.predict = true
    refreshInput()
    await screen.findByText('next prompt')
    expect(generate).toHaveBeenCalledTimes(2)
  })
})

describe('AgentOverlay prompt history search', () => {
  it('opens a localized dialog, navigates real candidates, and accepts Enter into the draft', () => {
    const { root } = setup()

    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Prompt history' })).toBeTruthy()
    const search = screen.getByRole('textbox', { name: 'Search prompt history' })
    const options = screen.getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual(['Other prompt', 'Needle one'])
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(search, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(search, { key: 'Enter', code: 'Enter' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(root.textContent).toBe('Needle one')
    expect(readSelection(root)).toEqual({ start: 10, end: 10 })
  })

  it('opens with Alt+R and leaves other Alt combinations untouched', () => {
    const { root } = setup()

    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', altKey: true })).toBe(false)
    const search = screen.getByRole('textbox', { name: 'Search prompt history' })
    fireEvent.keyDown(search, { key: 'Escape', code: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()

    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', altKey: true, ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', altKey: true, metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', altKey: true, shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(root.textContent).toBe('original draft')
  })

  it('uses the same guarded acceptance for a clicked candidate and filters case-insensitively', () => {
    const { root, persists } = setup()
    fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })
    const search = screen.getByRole('textbox', { name: 'Search prompt history' })

    fireEvent.change(search, { target: { value: 'needle' } })
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    fireEvent.click(options[0]!)

    expect(root.textContent).toBe('Needle one')
    expect(readSelection(root)).toEqual({ start: 10, end: 10 })
    expect(persists()).toBe(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('restores the original draft and caret on Escape and outside click without taking editor keys', () => {
    const { root, persists } = setup()
    fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })
    const search = screen.getByRole('textbox', { name: 'Search prompt history' })

    expect(fireEvent.keyDown(root, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(true)
    expect(root.textContent).toBe('original draft')
    fireEvent.keyDown(search, { key: 'Escape', code: 'Escape' })
    expect(root.textContent).toBe('original draft')
    expect(readSelection(root)).toEqual({ start: 8, end: 8 })

    fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(readSelection(root)).toBeNull()
    expect(persists()).toBe(1)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(root.textContent).toBe('original draft')
    expect(readSelection(root)).toEqual({ start: 8, end: 8 })
    expect(persists()).toBe(2)
  })

  it('invalidates pure history when a pointer opens an official menu without stealing events', () => {
    const { root, refreshInput } = setup()
    expect(fireEvent.keyDown(root, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(false)
    expect(root.textContent).toBe('Other prompt')
    refreshInput()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    const openMenu = () => {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      document.body.append(menu)
    }
    trigger.addEventListener('pointerdown', openMenu)

    expect(fireEvent.pointerDown(trigger)).toBe(true)
    expect(screen.getByRole('menu')).toBeTruthy()
    screen.getByRole('menu').remove()
    expect(fireEvent.keyDown(root, { key: 'Escape', code: 'Escape' })).toBe(true)
    expect(root.textContent).toBe('Other prompt')
  })

  it('disables all history keys without losing the draft and restores them on re-enable', () => {
    const { root, switches, refreshInput } = setup()
    fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })
    expect(screen.getByRole('dialog', { name: 'Prompt history' })).toBeTruthy()

    switches.history = false
    refreshInput()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(root.textContent).toBe('original draft')
    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(true)

    switches.history = true
    refreshInput()
    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(false)
    expect(screen.getByRole('dialog', { name: 'Prompt history' })).toBeTruthy()
  })

  it('keeps structured-chip drafts protected and removes listeners on unmount', () => {
    const { root, view } = setup([{
      occurrenceId: 7, source: 'file', ref: 'x', offset: 0, length: 1, label: 'o', clipboardText: 'o',
    }])

    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fireEvent.keyDown(root, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(true)
    expect(root.textContent).toBe('original draft')

    view.unmount()
    expect(fireEvent.keyDown(root, { key: 'r', code: 'KeyR', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(root, { key: 'ArrowUp', code: 'ArrowUp' })).toBe(true)
  })
})

describe('PluginSettings', () => {
  it('renders five module switches on by default with clear rollback boundaries', () => {
    settingsHarness()
    expect(screen.getByText('Toggle input helpers as needed')).toBeTruthy()
    expect(screen.getByText('↑↓ revisit sent prompts; Alt+R to search (Ctrl+R in compatible environments)')).toBeTruthy()
    expect(screen.getByText('Optimize the draft or selection, with one-click undo')).toBeTruthy()
    expect(screen.getByText('One suggestion after a reply; Tab to accept')).toBeTruthy()
    expect(screen.getByText('Click System / Tools / Messages on the official context meter to open details in the right sidebar')).toBeTruthy()
    expect(screen.getAllByRole('switch')).toHaveLength(5)
    expect(screen.getAllByRole('switch').map(item => item.getAttribute('aria-label'))).toEqual([
      'Prompt history', 'Optimize prompt', 'Next-prompt prediction', 'Conversation and file rollback', 'Context details',
    ])
    expect(screen.getByRole('switch', { name: 'Conversation and file rollback' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'Context details' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(translations.rollbackBoundary!)).toBeTruthy()
    expect(screen.getByText(translations.privacy!)).toBeTruthy()
    expect(screen.getByText(translations.coexistence!)).toBeTruthy()
    for (const forbidden of ['strength', 'continuation', 'template', 'usage', '强度', '续写', '模板', '用量']) {
      expect(screen.queryByText(new RegExp(forbidden, 'i'))).toBeNull()
    }
  })

  it('writes each requested value directly and follows the next accepted snapshot', async () => {
    const set = vi.fn(async () => true)
    const h = settingsHarness(set)
    fireEvent.click(screen.getByRole('switch', { name: 'Prompt history' }))
    await waitFor(() => { expect(set).toHaveBeenCalledWith('historyEnabled', false) })
    h.accept({ historyEnabled: false })
    expect(screen.getByRole('switch', { name: 'Prompt history' }).getAttribute('aria-checked')).toBe('false')
    expect(h.listeners.size).toBe(1)
    h.view.unmount()
    expect(h.listeners.size).toBe(0)
  })

  it.each(['refused', 'rejected'] as const)('restores the accepted value and shows a short error when a write is %s', async outcome => {
    const pending = deferred<boolean>()
    const set = vi.fn(() => outcome === 'refused'
      ? pending.promise
      : Promise.reject(new Error('private transport details')))
    settingsHarness(set)
    const toggle = screen.getByRole('switch', { name: 'Prompt history' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    if (outcome === 'refused') pending.resolve(false)
    const error = await screen.findByRole('status')
    expect(error.textContent).toBe('Setting was not saved. Try again.')
    expect(error.textContent).not.toContain('private transport details')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })

  it('disables all switches when the accepted form is not writable', () => {
    const h = settingsHarness()
    h.accept({}, false)
    for (const toggle of screen.getAllByRole('switch')) expect(toggle).toHaveProperty('disabled', true)
  })

  it('puts a model pill beside optimize/predict and saves catalog picks from the menu', async () => {
    const set = vi.fn(async () => true)
    const loadCatalog = vi.fn(async () => ({
      default: { provider: 'deepseek', model: 'deepseek-chat' },
      routableProviders: ['deepseek'],
      groups: [{
        id: 'deepseek',
        name: 'DeepSeek',
        models: [{
          id: 'deepseek-chat',
          name: 'DeepSeek Chat',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'low',
          },
        }],
      }],
      failures: [],
    }))
    const h = settingsHarness(set, {}, loadCatalog)
    const optimizePill = await screen.findByRole('button', { name: 'Optimize prompt Model' })
    expect(optimizePill.textContent).toContain('Follow session')
    expect(screen.getByRole('button', { name: 'Next-prompt prediction Model' })).toBeTruthy()
    fireEvent.click(optimizePill)
    fireEvent.click(await screen.findByRole('menuitem', { name: 'DeepSeek Chat · High' }))
    await waitFor(() => {
      expect(set.mock.calls).toEqual(expect.arrayContaining([
        ['optimizeProvider', 'deepseek'],
        ['optimizeModel', 'deepseek-chat'],
        ['optimizeReasoningEffort', 'high'],
      ]))
    })
    h.accept({
      optimizeProvider: 'deepseek',
      optimizeModel: 'deepseek-chat',
      optimizeReasoningEffort: 'high',
    })
    expect(screen.getByRole('button', { name: 'Optimize prompt Model' }).textContent).toContain('DeepSeek Chat · High')
  })
})

describe('CoexistenceHints', () => {
  it('shows each overlap once per release and dismissal never changes module settings', async () => {
    localStorage.clear()
    const set = vi.fn(async () => true)
    settingsHarness(set)
    const store = new OverlapHintStore(localStorage, 'test-release')
    const t = (key: string) => translations[key] ?? key
    render(<CoexistenceHints store={store} t={t} />)
    store.accept([{ moduleName: 'dsh-input-assistant', enabled: true }])
    expect(await screen.findByText(translations.overlapHistory!)).toBeTruthy()
    expect(screen.getByText(translations.overlapOptimize!)).toBeTruthy()
    expect(screen.getByText(translations.overlapPredict!)).toBeTruthy()
    expect(store.getSnapshot()).toEqual(['history', 'optimize', 'predict'])

    store.accept([{ moduleName: 'dsh-input-assistant', enabled: true }])
    expect(store.getSnapshot()).toEqual(['history', 'optimize', 'predict'])
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss coexistence notice' })[0]!)
    expect(store.getSnapshot()).toEqual(['optimize', 'predict'])
    expect(set).not.toHaveBeenCalled()
    expect(screen.getAllByRole('switch').map(item => item.getAttribute('aria-checked'))).toEqual([
      'true', 'true', 'true', 'true', 'true',
    ])

    const reopened = new OverlapHintStore(localStorage, 'test-release')
    reopened.accept([{ moduleName: 'dsh-input-assistant', enabled: true }])
    expect(reopened.getSnapshot()).toEqual([])
    const nextRelease = new OverlapHintStore(localStorage, 'next-release')
    nextRelease.accept([{ moduleName: 'dsh-input-assistant', enabled: true }])
    expect(nextRelease.getSnapshot()).toEqual(['history', 'optimize', 'predict'])
    for (const key of Object.keys(localStorage)) expect(localStorage.getItem(key)).not.toContain('Needle one')
  })
})
