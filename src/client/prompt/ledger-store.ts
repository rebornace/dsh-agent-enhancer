import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { PromptHistoryLedger } from './ledger.ts'

const ledgers = new Map<string, PromptHistoryLedger>()
const invalidators = new Set<(sessionId: SessionId) => void>()

export function promptLedgerFor(sessionId: SessionId): PromptHistoryLedger {
  const key = String(sessionId)
  let ledger = ledgers.get(key)
  if (ledger === undefined) {
    ledger = new PromptHistoryLedger()
    ledgers.set(key, ledger)
  }
  return ledger
}

export function disposePromptLedger(sessionId: SessionId): void {
  ledgers.delete(String(sessionId))
}

/** Let composers drop ↑↓ caches when the ledger gains newly observed prompts. */
export function subscribePromptLedgerInvalidation(
  listener: (sessionId: SessionId) => void,
): () => void {
  invalidators.add(listener)
  return () => { invalidators.delete(listener) }
}

export function invalidatePromptHistory(sessionId: SessionId): void {
  for (const listener of invalidators) listener(sessionId)
}
