import { AuxiliaryError } from '../../errors.ts'
import type { AuxiliaryErrorCode } from '../../errors.ts'
import type { AuxiliaryResult, OptimizeRequest, RecentExchange } from '../../host/types.ts'
import { textSegments } from '../dsh/structured.ts'
import type { Coordinator } from './coordinator.ts'
import type { DraftSelection, DraftSnapshot } from './types.ts'

export interface OptimizationCache {
  readonly source: string
  readonly optimized: string
  readonly selection: DraftSelection
  readonly sourceSegments?: readonly string[]
  readonly optimizedSegments?: readonly string[]
}

export class OptimizationStore {
  private value: OptimizationCache | null = null
  read(source: string): OptimizationCache | null {
    return this.value?.source === source ? this.value : null
  }
  write(cache: OptimizationCache): void { this.value = cache }
  invalidate(): void { this.value = null }
}

export interface OptimizationState {
  readonly status: 'optimize' | 'pending' | 'undo'
  readonly error: AuxiliaryErrorCode | null
}

export type GenerateOptimization = (
  request: OptimizeRequest,
  signal: AbortSignal,
) => Promise<AuxiliaryResult | null>

interface PendingOptimization {
  readonly requestId: string
  readonly abort: AbortController
}

let requestSequence = 0

export class OptimizationController {
  private readonly store = new OptimizationStore()
  private cache: OptimizationCache | null = null
  private cacheSourceDraft: string | null = null
  private cacheOptimizedDraft: string | null = null
  private current: DraftSnapshot | null = null
  private pending: PendingOptimization | null = null
  private view: OptimizationState = { status: 'optimize', error: null }
  private enabled = true
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly coordinator: Pick<Coordinator, 'applyOptimization' | 'undoOptimization'>,
    private readonly generate: GenerateOptimization,
  ) {}

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): OptimizationState {
    return this.view
  }

  sync(snapshot: DraftSnapshot): void {
    if (this.disposed) return
    const sessionChanged = this.current !== null && this.current.sessionId !== snapshot.sessionId
    if (this.view.error === 'ROLLBACK_FAILED' && !sessionChanged) {
      this.current = { ...snapshot }
      return
    }
    const textChanged = this.current !== null &&
      (this.current.sessionId !== snapshot.sessionId || this.current.text !== snapshot.text)
    this.current = { ...snapshot }
    const cache = this.readCache()
    if (cache !== null) {
      const optimizedVisible = cache.selection.sessionId === snapshot.sessionId && snapshot.text === this.cacheOptimizedDraft
      const sourceVisible = cache.selection.sessionId === snapshot.sessionId && snapshot.text === this.cacheSourceDraft
      if (!optimizedVisible && !sourceVisible) this.invalidate()
      else if (this.pending === null) this.setView(optimizedVisible ? 'undo' : 'optimize', textChanged ? null : this.view.error)
    } else if (this.pending === null && this.view.status === 'undo') {
      this.setView('optimize', null)
    }
    if (textChanged && this.view.error) this.setView(this.view.status, null)
  }

  async start(snapshot: DraftSnapshot, context: readonly RecentExchange[]): Promise<void> {
    if (this.disposed || !this.enabled || this.pending !== null || this.view.error === 'ROLLBACK_FAILED') return
    this.current = { ...snapshot }
    const cached = this.readCache()
    if (cached !== null && cached.selection.sessionId === snapshot.sessionId && snapshot.text === this.cacheSourceDraft &&
      (cached.selection.structured === true) === (snapshot.structured === true) &&
      (snapshot.start === snapshot.end ||
        (snapshot.start === cached.selection.start && snapshot.end === cached.selection.end))) {
      try {
        const selection: DraftSelection = { ...cached.selection, draftRev: snapshot.draftRev }
        const applied = this.coordinator.applyOptimization({
          text: cached.optimized,
          guard: { sessionId: selection.sessionId, draftRev: selection.draftRev },
          source: cached.source,
          selection,
          fullDraft: cached.source === this.cacheSourceDraft,
          segments: cached.optimizedSegments,
          sourceSegments: cached.sourceSegments,
        })
        if (applied) this.setView('undo', null)
      } catch (error) {
        this.handleError(error)
      }
      return
    }

    const selected = snapshot.start !== snapshot.end
    const structured = !selected && snapshot.structured === true
    const occurrences = structured ? snapshot.occurrences : undefined
    if (structured && occurrences === undefined) return
    const selection: DraftSelection = {
      sessionId: snapshot.sessionId,
      draftRev: snapshot.draftRev,
      start: selected ? snapshot.start : 0,
      end: selected ? snapshot.end : snapshot.text.length,
      ...(snapshot.occurrences === undefined ? {} : { occurrences: snapshot.occurrences }),
      ...(structured ? { structured: true } : {}),
    }
    const source = snapshot.text.slice(selection.start, selection.end)
    if (source.trim() === '') return
    const sourceSegments = structured ? textSegments(source, occurrences!) : undefined

    this.invalidate()
    const requestId = `optimize-${++requestSequence}`
    const pending: PendingOptimization = { requestId, abort: new AbortController() }
    this.pending = pending
    this.setView('pending', null)
    try {
      const result = await this.generate({
        operation: 'optimize', requestId, sessionId: selection.sessionId, source,
        references: occurrences?.map(occurrence => ({
          offset: occurrence.offset, length: occurrence.length, text: occurrence.clipboardText,
        })) ?? [],
        context,
      }, pending.abort.signal)
      if (this.pending !== pending || this.disposed) return
      this.pending = null
      if (result === null) {
        this.setView('optimize', 'MODEL_FAILED')
        return
      }
      if (result.requestId !== requestId) {
        this.setView('optimize', null)
        return
      }
      const optimizedSegments = structured ? result.segments : undefined
      const applied = this.coordinator.applyOptimization({
        text: result.text,
        guard: { sessionId: selection.sessionId, draftRev: selection.draftRev },
        source,
        selection,
        fullDraft: !selected,
        segments: optimizedSegments,
        sourceSegments,
      })
      if (!applied) {
        this.setView('optimize', null)
        return
      }
      this.cache = { source, optimized: result.text, selection, sourceSegments, optimizedSegments }
      this.cacheSourceDraft = snapshot.text
      this.cacheOptimizedDraft = snapshot.text.slice(0, selection.start) + result.text + snapshot.text.slice(selection.end)
      this.store.write(this.cache)
      this.setView('undo', null)
    } catch (error) {
      if (this.disposed || (this.pending !== null && this.pending !== pending)) return
      const code = error instanceof AuxiliaryError ? error.code : 'MODEL_FAILED'
      if (this.pending !== pending && code !== 'ROLLBACK_FAILED') return
      this.pending = null
      this.setView('optimize', pending.abort.signal.aborted ? null : code)
    }
  }

  handleError(error: unknown): void {
    if (this.disposed) return
    this.pending = null
    this.setView('optimize', error instanceof AuxiliaryError ? error.code : 'MODEL_FAILED')
  }

  undo(): boolean {
    if (this.disposed || !this.enabled || this.pending !== null) return false
    const cache = this.readCache()
    if (cache === null) return false
    try {
      const restored = this.coordinator.undoOptimization(cache)
      if (restored) this.setView('optimize', null)
      return restored
    } catch (error) {
      this.handleError(error)
      return false
    }
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.cancel()
      this.invalidate()
      this.setView('optimize', null)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
    this.invalidate()
    this.setView('optimize', null)
    this.listeners.clear()
  }

  private readCache(): OptimizationCache | null {
    if (this.cache === null) return null
    const cached = this.store.read(this.cache.source)
    if (cached === null) this.cache = null
    return cached
  }

  private invalidate(): void {
    this.cache = null
    this.cacheSourceDraft = null
    this.cacheOptimizedDraft = null
    this.store.invalidate()
  }

  private cancel(): void {
    const pending = this.pending
    this.pending = null
    pending?.abort.abort()
  }

  private setView(status: OptimizationState['status'], error: AuxiliaryErrorCode | null): void {
    if (this.view.status === status && this.view.error === error) return
    this.view = { status, error }
    for (const listener of this.listeners) listener()
  }
}
