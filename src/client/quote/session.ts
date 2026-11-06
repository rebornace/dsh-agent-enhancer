import type { SessionId } from '@deepseek-ai/dsh-session/types'

let lastSessionId: SessionId | undefined

/** Track the composer session that last published InputActions. */
export function rememberQuoteSession(sessionId: SessionId | undefined): void {
  if (sessionId === undefined) return
  lastSessionId = sessionId
}

/** Most recent composer session — used by sidebar quote hosts outside chat slots. */
export function lastQuoteSessionId(): SessionId | undefined {
  return lastSessionId
}
