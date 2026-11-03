import type { RecentExchange } from '../../host/types.ts'
import { Coordinator } from './coordinator.ts'
import type { PromptInput } from './coordinator.ts'
import { OptimizationController } from './optimize.ts'
import type { GenerateOptimization, OptimizationState } from './optimize.ts'
import { PredictionController } from './predict.ts'
import type { GeneratePrediction } from './predict.ts'
import type { PromptKey, DraftSnapshot, DraftWriter, KeyContext, ModuleSwitches } from './types.ts'

export interface PromptControlState extends OptimizationState {
  readonly enabled: boolean
  readonly canOptimize: boolean
  readonly hasChips: boolean
  readonly chipSelection: boolean
}

export class PromptSession {
  readonly coordinator: Coordinator
  private readonly optimization: OptimizationController
  private readonly prediction: PredictionController
  private writer: DraftWriter | null = null
  private input: PromptInput | null = null
  private context: readonly RecentExchange[] = []
  private hasChips = false
  private controls: PromptControlState
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly switches: ModuleSwitches,
    generateOptimization: GenerateOptimization,
    generatePrediction: GeneratePrediction,
  ) {
    const writer: DraftWriter = {
      replace: (text, selection, segments, source) => this.writer?.replace(text, selection, segments, source) ?? false,
      setDraft: (text, caret) => { this.writer?.setDraft(text, caret) },
    }
    this.coordinator = new Coordinator(writer, switches)
    this.optimization = new OptimizationController(this.coordinator, generateOptimization)
    this.prediction = new PredictionController(this.coordinator, generatePrediction)
    const state = this.optimization.getSnapshot()
    this.controls = {
      ...state,
      enabled: switches.optimize(),
      canOptimize: false,
      hasChips: false,
      chipSelection: false,
    }
    this.optimization.subscribe(() => { this.refreshControls() })
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  controlsSnapshot(): PromptControlState {
    return this.controls
  }

  attach(writer: DraftWriter): () => void {
    if (this.disposed) return () => {}
    this.writer = writer
    this.optimization.setEnabled(this.switches.optimize())
    this.prediction.setEnabled(this.switches.predict())
    this.refreshControls()
    return () => {
      if (this.writer !== writer) return
      this.writer = null
      this.optimization.setEnabled(false)
      this.prediction.setEnabled(false)
      this.refreshControls()
    }
  }

  refreshSettings(): void {
    if (this.disposed) return
    this.coordinator.refreshSettings()
    this.optimization.setEnabled(this.writer !== null && this.switches.optimize())
    this.prediction.setEnabled(this.writer !== null && this.switches.predict())
    this.refreshControls()
  }

  sync(input: PromptInput, context: readonly RecentExchange[], hasChips: boolean): void {
    if (this.disposed) return
    this.input = { ...input, selection: { ...input.selection } }
    this.context = context
    this.hasChips = hasChips
    this.coordinator.sync(input)
    this.optimization.setEnabled(this.writer !== null && this.switches.optimize())
    this.prediction.setEnabled(this.writer !== null && this.switches.predict())
    if (this.writer !== null) {
      this.optimization.sync(this.snapshot(input))
      this.prediction.sync(input, context)
    }
    this.refreshControls()
  }

  optimize(): Promise<void> {
    if (this.disposed || this.input === null || !this.controls.canOptimize) return Promise.resolve()
    return this.optimization.start(this.snapshot(this.input), this.context)
  }

  undo(): boolean {
    return !this.disposed && this.optimization.undo()
  }

  handleKey(key: PromptKey, context: KeyContext): boolean {
    if (this.disposed) return false
    try {
      return this.coordinator.handleKey(key, context)
    } catch (error) {
      this.optimization.handleError(error)
      return true
    }
  }

  cancelPrediction(): void {
    if (!this.disposed) this.prediction.cancel()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.writer = null
    this.prediction.dispose()
    this.coordinator.dispose()
    this.optimization.dispose()
    this.listeners.clear()
  }

  private snapshot(input: PromptInput): DraftSnapshot {
    return {
      sessionId: input.sessionId,
      draftRev: input.draftRev,
      start: input.selection.start,
      end: input.selection.end,
      text: input.draft,
      ...(input.occurrences.length > 0 ? { occurrences: input.occurrences } : {}),
      ...(input.selection.start === input.selection.end && input.occurrences.length > 0
        ? { structured: true }
        : {}),
    }
  }

  private refreshControls(): void {
    if (this.disposed) return
    const state = this.optimization.getSnapshot()
    const enabled = this.switches.optimize()
    const input = this.input
    const selected = input !== null && input.selection.start !== input.selection.end
    const chipSelection = input !== null && selected && input.occurrences.some(occurrence =>
      input.selection.start < occurrence.offset + occurrence.length && input.selection.end > occurrence.offset)
    const source = input === null ? '' : selected
      ? input.draft.slice(input.selection.start, input.selection.end)
      : input.draft
    const next: PromptControlState = {
      ...state,
      enabled,
      canOptimize: this.writer !== null && enabled && !chipSelection && source.trim() !== '',
      hasChips: this.hasChips,
      chipSelection,
    }
    if (this.controls.status === next.status && this.controls.error === next.error &&
      this.controls.enabled === next.enabled && this.controls.canOptimize === next.canOptimize &&
      this.controls.hasChips === next.hasChips && this.controls.chipSelection === next.chipSelection) return
    this.controls = next
    for (const listener of this.listeners) listener()
  }
}
