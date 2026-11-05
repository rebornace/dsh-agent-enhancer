import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionCut } from './cut-store.ts'
import { isWithdrawnByCut } from './cut-store.ts'

/**
 * Build model-visible messages while skipping surface nodes withdrawn by the cut.
 * Continuation after restoredAtSeq stays visible.
 */
export function deriveMessagesWithCut(
  session: Pick<Session, 'surface' | 'snapshotEvents' | 'deriveEventMessage'>,
  cut: SessionCut | null | undefined,
): Message[] {
  if (cut === null || cut === undefined) {
    // Caller should prefer the native path when nothing is cut.
  }
  const events = session.snapshotEvents()
  const bySeq = new Map(events.map(event => [Number(event.seq), event] as const))
  const messages: Message[] = []
  for (const seq of session.surface.nodes) {
    const value = Number(seq)
    const event = bySeq.get(value)
    if (event === undefined) continue
    // Desktop injects the protected system prompt after turn/start — never cut it away.
    const keepSystem = event.type === 'system/message'
    if (cut !== null && cut !== undefined && isWithdrawnByCut(cut, value) && !keepSystem) continue
    const message = session.deriveEventMessage(event)
    if (message !== null) messages.push(message)
  }
  return messages
}
