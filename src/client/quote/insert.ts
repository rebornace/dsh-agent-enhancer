import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { rollbackInputActionsFor } from '../rollback/input-actions-cache.ts'
import { lastQuoteSessionId } from './session.ts'

/**
 * Insert one nonblank selection as an atomic composer quote.
 * @returns false when text is blank, no session is known, or the editor refused.
 */
export function quoteSelectedText(
  text: string,
  sessionId: SessionId | undefined = lastQuoteSessionId(),
): boolean {
  const trimmed = text.replace(/\r\n?/gu, '\n').trim()
  if (trimmed === '' || sessionId === undefined) return false
  return rollbackInputActionsFor(sessionId).insertQuote(trimmed)
}
