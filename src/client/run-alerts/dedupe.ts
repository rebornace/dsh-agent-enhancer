import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RunAlertEvent, RunAlertKind } from './types.ts'

const DEFAULT_WINDOW_MS = 4_000

function eventKey(event: RunAlertEvent): string {
  const pending = event.pendingKind ?? ''
  return `${event.sessionId}:${event.kind}:${pending}`
}

/** Short-window dedupe so finish + unread edges (or burst pending) do not double-fire. */
export class RunAlertDedupe {
  private readonly lastAt = new Map<string, number>()

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  accept(event: RunAlertEvent, now: number = Date.now()): boolean {
    const key = eventKey(event)
    const previous = this.lastAt.get(key)
    if (previous !== undefined && now - previous < this.windowMs) return false
    this.lastAt.set(key, now)
    this.prune(now)
    return true
  }

  /** Also suppress a second finish for the same session within the window (unread + running). */
  acceptFinish(sessionId: SessionId, now: number = Date.now()): boolean {
    return this.accept({ sessionId, kind: 'finished' satisfies RunAlertKind }, now)
  }

  clear(): void {
    this.lastAt.clear()
  }

  private prune(now: number): void {
    for (const [key, at] of this.lastAt) {
      if (now - at >= this.windowMs * 4) this.lastAt.delete(key)
    }
  }
}
