import type { PromptEntry } from './types.ts'

/**
 * Session input snapshots for ↑↓ / search history.
 * Unique by exact prompt text (same characters → one row); newer seq wins.
 * Chat filters and rollback must not drop distinct prompts from this ledger.
 * Rollback draft prefill is a separate composer write — never feed it here.
 */
export class PromptHistoryLedger {
  /** Keyed by exact `text`; value is the newest seq for that string. */
  private readonly byText = new Map<string, PromptEntry>()

  observe(incoming: readonly PromptEntry[]): readonly PromptEntry[] {
    for (const entry of incoming) {
      if (entry.text.trim() === '') continue
      const previous = this.byText.get(entry.text)
      if (previous !== undefined && previous.seq > entry.seq) continue
      this.byText.set(entry.text, entry)
    }
    return this.list()
  }

  list(): readonly PromptEntry[] {
    return [...this.byText.values()].sort((a, b) => a.seq - b.seq)
  }

  clear(): void {
    this.byText.clear()
  }
}
