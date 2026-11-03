/** Latest user-turn text from the session log — used when Auto rematches without a warm route cache. */

interface ContentBlockLike {
  readonly type?: string
  readonly text?: string
}

interface LoggedEvent {
  readonly type: string
  readonly data?: { readonly content?: readonly ContentBlockLike[] }
}

export interface SessionTurnHint {
  readonly text: string
  readonly toolHeavy: boolean
}

function textOf(content: readonly ContentBlockLike[] | undefined): string {
  if (content === undefined) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Walk `snapshotEvents` for the latest user message (and any tool-result signal). */
export function sessionTurnHint(session: object | undefined): SessionTurnHint | undefined {
  if (session === undefined) return undefined
  const events = (session as { snapshotEvents?: () => readonly LoggedEvent[] }).snapshotEvents?.()
  if (events === undefined) return undefined
  let text = ''
  let toolHeavy = false
  let saw = false
  for (const event of events) {
    if (event.type === 'tool/result') {
      toolHeavy = true
      saw = true
    }
    if (event.type !== 'user/message') continue
    const next = textOf(event.data?.content)
    if (next === '') continue
    text = next
    saw = true
  }
  return saw ? { text, toolHeavy } : undefined
}
