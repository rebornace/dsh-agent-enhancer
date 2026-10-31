import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AuxiliaryResult, PredictRequest, RecentExchange } from '../../host/types.ts'
import type { ComposerInput, Coordinator } from './coordinator.ts'

export interface PredictionRequest {
  readonly sessionId: SessionId
  readonly turn: number
  readonly draftRev: number
  readonly context: readonly RecentExchange[]
}
export class PredictionGate {
  private requested = new Set<string>()
  shouldStart(request: PredictionRequest, running: boolean, draft: string): boolean {
    const key = `${String(request.sessionId)}:${request.turn}`
    return !running && draft === '' && request.turn > 0 && !this.requested.has(key)
  }
  mark(request: PredictionRequest): void {
    this.requested.add(`${String(request.sessionId)}:${request.turn}`)
  }
}

export type GeneratePrediction = (
  request: PredictRequest,
  signal: AbortSignal,
) => Promise<AuxiliaryResult | null>

interface PendingPrediction {
  readonly requestId: string
  readonly sessionId: SessionId
  readonly turn: number
  readonly draftRev: number
  readonly abort: AbortController
}

let requestSequence = 0

export class PredictionController {
  private readonly gate = new PredictionGate()
  private current: { readonly input: ComposerInput; readonly turn: number } | null = null
  private pending: PendingPrediction | null = null
  private enabled = true
  private disposed = false

  constructor(
    private readonly coordinator: Pick<Coordinator, 'showPrediction' | 'dismissPrediction'>,
    private readonly generate: GeneratePrediction,
  ) {}

  sync(input: ComposerInput, context: readonly RecentExchange[]): void {
    if (this.disposed) return
    const previous = this.current
    const turn = context.at(-1)?.turn ?? 0
    this.current = { input: { ...input, selection: { ...input.selection } }, turn }
    if (previous !== null && previous.turn !== turn) this.coordinator.dismissPrediction()
    if (this.pending !== null && !this.matches(this.pending)) this.cancel()
    if (!this.enabled || String(input.sessionId).trim() === '') return

    const request: PredictionRequest = { sessionId: input.sessionId, turn, draftRev: input.draftRev, context }
    if (!this.gate.shouldStart(request, input.running, input.draft)) return
    this.gate.mark(request)
    const pending: PendingPrediction = {
      requestId: `predict-${++requestSequence}`,
      sessionId: input.sessionId,
      turn,
      draftRev: input.draftRev,
      abort: new AbortController(),
    }
    this.pending = pending
    void this.start(pending, context)
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) this.cancel()
  }

  cancel(): void {
    const pending = this.pending
    this.pending = null
    pending?.abort.abort()
    this.coordinator.dismissPrediction()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancel()
  }

  private matches(pending: PendingPrediction): boolean {
    return this.current !== null && this.current.input.sessionId === pending.sessionId &&
      this.current.turn === pending.turn && this.current.input.draftRev === pending.draftRev &&
      this.current.input.draft === '' && !this.current.input.running
  }

  private async start(pending: PendingPrediction, context: readonly RecentExchange[]): Promise<void> {
    try {
      const result = await this.generate({
        operation: 'predict',
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        context,
      }, pending.abort.signal)
      if (this.pending !== pending || this.disposed) return
      this.pending = null
      if (!this.enabled || !this.matches(pending) || result === null || result.requestId !== pending.requestId) return
      const text = result.text.trim()
      if (text === '') return
      this.coordinator.showPrediction({
        text,
        guard: { sessionId: pending.sessionId, draftRev: pending.draftRev },
      })
    } catch {
      if (this.pending === pending) this.pending = null
    }
  }
}
