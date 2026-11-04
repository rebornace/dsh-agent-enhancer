import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { textSegments } from '../dsh/structured.ts'
import { PromptHistory } from './history.ts'
import type {
  PromptKey,
  DraftGuard,
  DraftSelection,
  DraftSnapshot,
  DraftWriter,
  KeyContext,
  ModuleSwitches,
  Occurrence,
  PromptEntry,
} from './types.ts'

export interface PromptInput {
  readonly sessionId: SessionId
  readonly draft: string
  readonly draftRev: number
  readonly selection: { readonly start: number; readonly end: number }
  readonly occurrences: readonly Occurrence[]
  readonly running: boolean
}

export interface HistoryActions {
  load(sessionId: SessionId): readonly PromptEntry[] | Promise<readonly PromptEntry[]>
}

export interface TextResult {
  readonly text: string
  readonly guard: DraftGuard
}

export interface PromptSearchState {
  readonly original: DraftSnapshot
  readonly query: string
  readonly entries: readonly PromptEntry[]
  readonly selectedSeq: number | null
}

type PromptMode =
  | { readonly kind: 'editing' }
  | { readonly kind: 'history'; original: DraftSnapshot; index: number }
  | { readonly kind: 'search'; original: DraftSnapshot; query: string }
  | { readonly kind: 'prediction'; text: string; guard: DraftGuard }
  | {
    readonly kind: 'optimized'
    readonly original: DraftSelection
    readonly source: string
    readonly sourceSegments?: readonly string[]
    readonly optimizedSegments?: readonly string[]
  }

type ExpectedWrite = {
  readonly sessionId: SessionId
  readonly text: string
  readonly kind: 'history' | 'optimized'
}

type CacheEntry = { readonly entries: readonly PromptEntry[]; readonly cachedAt: number }

export class Coordinator {
  private input: PromptInput | null = null
  private mode: PromptMode = { kind: 'editing' }
  private expected: ExpectedWrite | null = null
  private optimizedEnd: number | null = null
  private historyActions: HistoryActions | null = null
  private readonly historyCache = new Map<SessionId, CacheEntry>()
  private readonly historyPending = new Map<SessionId, Promise<readonly PromptEntry[]>>()
  private searchEntries: readonly PromptEntry[] = []
  private searchIndex = -1
  private generation = 0
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly writer: DraftWriter,
    private readonly switches: ModuleSwitches,
    private readonly clock: () => number = Date.now,
  ) {}

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  searchSnapshot(): PromptSearchState | null {
    if (this.mode.kind !== 'search') return null
    return {
      original: this.mode.original,
      query: this.mode.query,
      entries: this.searchEntries,
      selectedSeq: this.searchEntries[this.searchIndex]?.seq ?? null,
    }
  }

  predictionSnapshot(): string | null {
    return this.mode.kind === 'prediction' ? this.mode.text : null
  }

  dismissPrediction(): void {
    if (this.disposed || this.mode.kind !== 'prediction') return
    this.generation += 1
    this.resetTransient()
  }

  registerHistory(actions: HistoryActions): () => void {
    if (this.disposed) return () => {}
    this.generation += 1
    this.historyActions = actions
    this.historyCache.clear()
    this.historyPending.clear()
    this.resetTransient()
    return () => {
      if (this.historyActions !== actions) return
      this.generation += 1
      this.historyActions = null
      this.historyPending.clear()
    }
  }

  /** Drop cached ↑↓ / search entries without leaving history mode. */
  invalidateHistoryCache(sessionId?: SessionId): void {
    if (this.disposed) return
    if (sessionId === undefined) this.historyCache.clear()
    else this.historyCache.delete(sessionId)
    this.historyPending.clear()
  }

  refreshSettings(): void {
    if (this.disposed || this.switches.history()) return
    if (this.mode.kind !== 'history' && this.mode.kind !== 'search') return
    this.generation += 1
    this.resetTransient()
  }

  sync(input: PromptInput): void {
    if (this.disposed) return
    const previous = this.input
    const sessionChanged = previous !== null && previous.sessionId !== input.sessionId
    const revisionChanged = previous !== null &&
      (previous.sessionId !== input.sessionId || previous.draftRev !== input.draftRev)
    const draftChanged = previous !== null && previous.draft !== input.draft
    const structureChanged = previous !== null && !sameOccurrences(previous.occurrences, input.occurrences)
    const turnStarted = previous !== null && !previous.running && input.running
    if (sessionChanged || revisionChanged || draftChanged || structureChanged || turnStarted) this.generation += 1

    const preserve = previous !== null && !sessionChanged && revisionChanged &&
      this.expected !== null && this.expected.sessionId === input.sessionId &&
      this.expected.text === input.draft && this.expected.kind === this.mode.kind

    this.input = {
      ...input,
      selection: { ...input.selection },
    }
    if (!preserve && (sessionChanged || revisionChanged || draftChanged || structureChanged || turnStarted)) this.resetTransient()
    this.expected = null
  }

  showPrediction(result: TextResult): boolean {
    if (!this.current(result.guard) || !this.switches.predict() || this.input?.draft !== '') return false
    this.generation += 1
    this.mode = { kind: 'prediction', text: result.text, guard: result.guard }
    this.expected = null
    this.emit()
    return true
  }

  applyOptimization(result: TextResult & {
    readonly source?: string
    readonly selection?: DraftSelection
    readonly fullDraft?: boolean
    readonly segments?: readonly string[]
    readonly sourceSegments?: readonly string[]
  }): boolean {
    if (!this.current(result.guard) || !this.switches.optimize() || this.input === null) return false
    if (result.fullDraft === true && this.input.draft !== result.source) return false
    const selection = result.selection ?? this.selection()
    if (selection.sessionId !== result.guard.sessionId || selection.draftRev !== result.guard.draftRev ||
      selection.start < 0 || selection.end < selection.start || selection.end > this.input.draft.length) return false
    const source = this.input.draft.slice(selection.start, selection.end)
    if (result.source !== undefined && result.source !== source) return false
    const occurrences = selection.occurrences
    if (selection.structured === true) {
      if (result.fullDraft !== true || selection.start !== 0 || selection.end !== source.length ||
        occurrences === undefined || result.segments === undefined ||
        result.segments.length !== occurrences.length + 1 || !sameOccurrences(occurrences, this.input.occurrences)) return false
      if (result.sourceSegments !== undefined &&
        !sameSegments(textSegments(source, occurrences), result.sourceSegments)) return false
    }
    if (!this.writer.replace(result.text, selection, result.segments, source)) return false
    this.generation += 1
    const draft = this.input.draft.slice(0, selection.start) + result.text + this.input.draft.slice(selection.end)
    this.mode = {
      kind: 'optimized', original: selection, source,
      sourceSegments: result.sourceSegments, optimizedSegments: result.segments,
    }
    this.optimizedEnd = selection.start + result.text.length
    this.expected = { sessionId: selection.sessionId, text: draft, kind: 'optimized' }
    this.updateLocalDraft(draft, this.optimizedEnd)
    return true
  }

  undoOptimization(cache: {
    readonly source: string
    readonly optimized: string
    readonly selection: DraftSelection
    readonly sourceSegments?: readonly string[]
    readonly optimizedSegments?: readonly string[]
  }): boolean {
    if (this.disposed || this.input === null || this.input.sessionId !== cache.selection.sessionId) return false
    const end = cache.selection.start + cache.optimized.length
    if (this.input.draft.slice(cache.selection.start, end) !== cache.optimized) return false
    const structured = cache.selection.structured === true
    if (structured && (cache.sourceSegments === undefined || cache.optimizedSegments === undefined ||
      cache.optimizedSegments.length !== this.input.occurrences.length + 1 ||
      !sameOptimizedOccurrences(
        cache.selection.occurrences, this.input.occurrences, cache.sourceSegments, cache.optimizedSegments,
      ) || !sameSegments(textSegments(this.input.draft, this.input.occurrences), cache.optimizedSegments))) return false
    const selection: DraftSelection = {
      sessionId: this.input.sessionId,
      draftRev: this.input.draftRev,
      start: cache.selection.start,
      end,
      ...(this.input.occurrences.length > 0 ? { occurrences: this.input.occurrences } : {}),
      ...(structured ? { structured: true } : {}),
    }
    if (!this.writer.replace(cache.source, selection, cache.sourceSegments, this.input.draft)) return false
    const restored = this.input.draft.slice(0, selection.start) + cache.source + this.input.draft.slice(end)
    this.generation += 1
    this.resetTransient()
    this.updateLocalDraft(restored, selection.start + cache.source.length)
    return true
  }

  updateSearch(query: string): boolean {
    if (this.disposed || this.mode.kind !== 'search' || this.input === null) return false
    const generation = this.generation
    const guard = guardOf(this.input)
    const entries = this.loadHistory(this.input.sessionId)
    if (Array.isArray(entries)) {
      this.searchEntries = new PromptHistory(entries).search(query)
      this.searchIndex = this.searchEntries.length > 0 ? 0 : -1
      this.mode = { ...this.mode, query }
      this.emit()
      return true
    }
    this.mode = { ...this.mode, query }
    this.emit()
    void Promise.resolve(entries).then(loaded => {
      if (this.disposed || generation !== this.generation || !this.current(guard) || this.mode.kind !== 'search') return
      this.searchEntries = new PromptHistory(loaded).search(this.mode.query)
      this.searchIndex = this.searchEntries.length > 0 ? 0 : -1
      this.emit()
    })
    return true
  }

  handleKey(key: PromptKey, context: KeyContext): boolean {
    if (this.disposed || context.composing || context.systemLayerOpen) return false
    if (context.officialMenuOpen) {
      if (this.mode.kind === 'history' || this.mode.kind === 'search') {
        this.generation += 1
        this.resetTransient()
      }
      return false
    }
    if (key === 'tab' && this.mode.kind === 'prediction') return this.acceptPrediction()
    if (key === 'escape' && this.dismissTransient()) return true
    if (this.switches.history() && key === 'search') return this.openSearch()
    if (this.switches.history() && key === 'up' && context.atFirstLine) return this.historyPrevious()
    if (this.switches.history() && key === 'down' && context.atLastLine) return this.historyNext()
    if (key === 'enter' && this.mode.kind === 'search') return this.acceptSearchCandidate()
    return false
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.historyActions = null
    this.historyPending.clear()
    this.resetTransient()
  }

  private current(guard: DraftGuard): boolean {
    return !this.disposed && this.input !== null &&
      this.input.sessionId === guard.sessionId && this.input.draftRev === guard.draftRev
  }

  private selection(): DraftSelection {
    if (this.input === null) throw new Error('Prompt session is not synchronized')
    return {
      sessionId: this.input.sessionId,
      draftRev: this.input.draftRev,
      start: this.input.selection.start,
      end: this.input.selection.end,
    }
  }

  private snapshot(): DraftSnapshot {
    if (this.input === null) throw new Error('Prompt session is not synchronized')
    return { ...this.selection(), text: this.input.draft }
  }

  private resetTransient(): void {
    this.mode = { kind: 'editing' }
    this.expected = null
    this.optimizedEnd = null
    this.searchEntries = []
    this.searchIndex = -1
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private updateLocalDraft(text: string, caret: number): void {
    if (this.input === null) return
    this.input = { ...this.input, draft: text, selection: { start: caret, end: caret } }
  }

  private acceptPrediction(): boolean {
    if (this.mode.kind !== 'prediction' || !this.current(this.mode.guard) || !this.switches.predict()) return false
    const text = this.mode.text
    this.generation += 1
    this.mode = { kind: 'editing' }
    this.writer.setDraft(text, text.length)
    this.updateLocalDraft(text, text.length)
    this.emit()
    return true
  }

  acceptHistory(entry: PromptEntry, guard: DraftGuard): boolean {
    if (this.mode.kind !== 'search' || !this.current(guard) ||
      !this.searchEntries.some(candidate => candidate.seq === entry.seq && candidate.text === entry.text)) return false
    this.generation += 1
    this.resetTransient()
    this.writer.setDraft(entry.text, entry.text.length)
    this.updateLocalDraft(entry.text, entry.text.length)
    return true
  }

  private dismissTransient(): boolean {
    if (this.input === null || this.mode.kind === 'editing') return false
    if (this.mode.kind === 'prediction') {
      this.generation += 1
      this.resetTransient()
      return true
    }
    if (this.mode.kind === 'history' || this.mode.kind === 'search') {
      this.restoreOriginal(this.mode.original)
      return true
    }
    const mode = this.mode
    if (this.optimizedEnd === null) return false
    const structured = mode.original.structured === true
    if (structured && (mode.sourceSegments === undefined || mode.optimizedSegments === undefined ||
      !sameOptimizedOccurrences(
        mode.original.occurrences, this.input.occurrences, mode.sourceSegments, mode.optimizedSegments,
      ))) return false
    const end = this.optimizedEnd
    const selection: DraftSelection = {
      sessionId: this.input.sessionId,
      draftRev: this.input.draftRev,
      start: mode.original.start,
      end,
      ...(this.input.occurrences.length > 0 ? { occurrences: this.input.occurrences } : {}),
      ...(structured ? { structured: true } : {}),
    }
    if (!this.writer.replace(mode.source, selection, mode.sourceSegments, this.input.draft)) return false
    const restored = this.input.draft.slice(0, mode.original.start) + mode.source + this.input.draft.slice(end)
    this.generation += 1
    this.resetTransient()
    this.updateLocalDraft(restored, mode.original.start + mode.source.length)
    return true
  }

  private restoreOriginal(original: DraftSnapshot): void {
    this.generation += 1
    this.resetTransient()
    this.writer.setDraft(original.text, original.end)
    this.updateLocalDraft(original.text, original.end)
  }

  private openSearch(): boolean {
    if (this.input === null || this.historyActions === null) return false
    this.generation += 1
    const original = this.snapshot()
    const generation = this.generation
    const guard = guardOf(this.input)
    this.mode = { kind: 'search', original, query: '' }
    this.searchEntries = []
    this.searchIndex = -1
    this.emit()
    const entries = this.loadHistory(this.input.sessionId)
    if (Array.isArray(entries)) {
      this.updateSearch('')
    } else {
      void Promise.resolve(entries).then(loaded => {
        if (this.disposed || generation !== this.generation || !this.current(guard) || this.mode.kind !== 'search') return
        this.updateSearch(this.mode.query)
      })
    }
    return true
  }

  private historyPrevious(): boolean {
    if (this.input === null || this.historyActions === null) return false
    if (this.mode.kind === 'search') {
      if (this.searchIndex < 0) return true
      this.searchIndex = Math.min(this.searchIndex + 1, this.searchEntries.length - 1)
      this.emit()
      return true
    }
    const original = this.mode.kind === 'history' ? this.mode.original : this.snapshot()
    const index = this.mode.kind === 'history' ? this.mode.index : null
    const generation = this.generation
    const guard = guardOf(this.input)
    const entries = this.loadHistory(this.input.sessionId)
    if (Array.isArray(entries)) {
      this.selectHistory(new PromptHistory(entries).previous(index), original)
    } else {
      void Promise.resolve(entries).then(loaded => {
        if (this.disposed || generation !== this.generation || !this.current(guard)) return
        this.selectHistory(new PromptHistory(loaded).previous(index), original)
      })
    }
    return true
  }

  private historyNext(): boolean {
    if (this.input === null) return false
    if (this.mode.kind === 'search') {
      if (this.searchIndex >= 0) {
        this.searchIndex -= 1
        this.emit()
      }
      return true
    }
    if (this.mode.kind !== 'history') return false
    const original = this.mode.original
    const index = this.mode.index
    const generation = this.generation
    const guard = guardOf(this.input)
    const entries = this.loadHistory(this.input.sessionId)
    const apply = (loaded: readonly PromptEntry[]) => {
      const selected = new PromptHistory(loaded).next(index)
      if (selected === null) return
      if (selected.index === null) {
        this.restoreOriginal(original)
        return
      }
      this.selectHistory(selected, original)
    }
    if (Array.isArray(entries)) {
      apply(entries)
    } else {
      void Promise.resolve(entries).then(loaded => {
        if (this.disposed || generation !== this.generation || !this.current(guard)) return
        if (this.mode.kind !== 'history') return
        apply(loaded)
      })
    }
    return true
  }

  private selectHistory(selected: { text: string; index: number | null } | null, original: DraftSnapshot): void {
    if (this.input === null || selected === null || selected.index === null) return
    const selection: DraftSelection = {
      sessionId: this.input.sessionId,
      draftRev: this.input.draftRev,
      start: 0,
      end: this.input.draft.length,
    }
    if (!this.writer.replace(selected.text, selection)) return
    this.mode = { kind: 'history', original, index: selected.index }
    this.expected = { sessionId: selection.sessionId, text: selected.text, kind: 'history' }
    this.updateLocalDraft(selected.text, selected.text.length)
  }

  private loadHistory(sessionId: SessionId): readonly PromptEntry[] | Promise<readonly PromptEntry[]> {
    const cached = this.historyCache.get(sessionId)
    if (cached !== undefined) return cached.entries
    const pending = this.historyPending.get(sessionId)
    if (pending !== undefined) return pending
    const actions = this.historyActions
    if (actions === null) return []
    try {
      const loaded = actions.load(sessionId)
      if (Array.isArray(loaded)) {
        this.historyCache.set(sessionId, { entries: loaded, cachedAt: this.clock() })
        return loaded
      }
      const request = Promise.resolve(loaded).then(entries => {
        this.historyPending.delete(sessionId)
        if (!this.disposed && this.historyActions === actions) {
          this.historyCache.set(sessionId, { entries, cachedAt: this.clock() })
        }
        return entries
      }, () => {
        this.historyPending.delete(sessionId)
        return []
      })
      this.historyPending.set(sessionId, request)
      return request
    } catch {
      return []
    }
  }

  private acceptSearchCandidate(): boolean {
    if (this.mode.kind !== 'search') return false
    const entry = this.searchEntries[this.searchIndex]
    if (entry === undefined) return false
    return this.acceptHistory(entry, this.mode.original)
  }
}

function guardOf(input: PromptInput): DraftGuard {
  return { sessionId: input.sessionId, draftRev: input.draftRev }
}

function sameOccurrences(left: readonly Occurrence[], right: readonly Occurrence[]): boolean {
  return left.length === right.length && left.every((occurrence, index) => {
    const other = right[index]!
    return occurrence.occurrenceId === other.occurrenceId && occurrence.source === other.source &&
      occurrence.ref === other.ref && occurrence.offset === other.offset && occurrence.length === other.length &&
      occurrence.label === other.label && occurrence.clipboardText === other.clipboardText &&
      occurrence.appearance === other.appearance && occurrence.invalid === other.invalid
  })
}

function sameOptimizedOccurrences(
  original: readonly Occurrence[] | undefined,
  current: readonly Occurrence[],
  sourceSegments: readonly string[],
  optimizedSegments: readonly string[],
): boolean {
  if (original === undefined || sourceSegments.length !== original.length + 1 ||
    optimizedSegments.length !== original.length + 1) return false
  let shift = 0
  const expected = original.map((occurrence, index) => {
    shift += optimizedSegments[index]!.length - sourceSegments[index]!.length
    return { ...occurrence, offset: occurrence.offset + shift }
  })
  return sameOccurrences(expected, current)
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}
