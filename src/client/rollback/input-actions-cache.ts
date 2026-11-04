import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const cache = new Map<SessionId, InputActions>()

const stubActions: InputActions = {
  insertQuote: () => false,
  captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }),
  insertText: () => false,
  setDraft: () => {},
  persistDraft: () => {},
  addAttachments: () => false,
  removeAttachment: () => {},
  pruneAttachments: () => {},
  submit: () => {},
}

/** Remember the stable composer InputActions so the timeline modal can confirm restores. */
export function rememberRollbackInputActions(
  sessionId: SessionId | undefined,
  actions: InputActions | undefined,
): void {
  if (sessionId === undefined || actions === undefined) return
  cache.set(sessionId, actions)
}

export function rollbackInputActionsFor(sessionId: SessionId): InputActions {
  return cache.get(sessionId) ?? stubActions
}
