import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TranscriptCut } from './transcript.ts'

/** In-memory session → projection cut for chat transcript filtering. */
export class SessionCutCache {
  private readonly cuts = new Map<SessionId, TranscriptCut | null>()
  private readonly listeners = new Set<() => void>()

  get(sessionId: SessionId): TranscriptCut | null | undefined {
    return this.cuts.get(sessionId)
  }

  set(sessionId: SessionId, cut: TranscriptCut | null): void {
    const previous = this.cuts.get(sessionId)
    if (previous === cut
      || (previous !== undefined && cut !== null && previous !== null
        && previous.hideTurnsFrom === cut.hideTurnsFrom
        && previous.cutSeq === cut.cutSeq
        && previous.restoredAtSeq === cut.restoredAtSeq)) {
      if (previous === undefined && cut === null) {
        this.cuts.set(sessionId, null)
        this.emit()
      }
      return
    }
    this.cuts.set(sessionId, cut)
    this.emit()
  }

  clear(sessionId: SessionId): void {
    if (!this.cuts.has(sessionId)) return
    this.cuts.delete(sessionId)
    this.emit()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
