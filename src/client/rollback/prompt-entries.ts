import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PromptEntry } from '../prompt/types.ts'

/**
 * Collect direct human prompts from a session event window.
 * Used to feed the prompt-history ledger before transcript filtering hides
 * rolled-back turns — history is an input snapshot, not a rollback artifact.
 */
export function promptsFromSessionEntries(
  entries: readonly SessionEventLikeEntry[],
): readonly PromptEntry[] {
  const out: PromptEntry[] = []
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'user') continue
    const text = event.data.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])
      .join('')
    if (text.trim() === '') continue
    out.push({ seq: Number(event.seq), text })
  }
  return out
}
