import type { PromptEntry } from './types.ts'

export interface HistorySnapshot { readonly text: string; readonly index: number | null }

export class PromptHistory {
  constructor(private entries: readonly PromptEntry[]) {
    // Newest-first; one row per exact text (and per seq if the same string raced in).
    const bySeq = new Map<number, PromptEntry>()
    for (const entry of entries) {
      if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry)
    }
    const newestFirst = [...bySeq.values()].sort((a, b) => b.seq - a.seq)
    const seenText = new Set<string>()
    this.entries = newestFirst.filter(entry => {
      if (seenText.has(entry.text)) return false
      seenText.add(entry.text)
      return true
    })
  }

  previous(index: number | null): HistorySnapshot | null {
    if (this.entries.length === 0) return null
    const nextIndex = index === null ? 0 : Math.min(index + 1, this.entries.length - 1)
    return { text: this.entries[nextIndex]!.text, index: nextIndex }
  }

  next(index: number): HistorySnapshot | null {
    if (this.entries.length === 0) return null
    if (index <= 0) return { text: '', index: null }
    const nextIndex = Math.min(index - 1, this.entries.length - 1)
    return { text: this.entries[nextIndex]!.text, index: nextIndex }
  }

  search(query: string): readonly PromptEntry[] {
    const normalized = query.trim().toLocaleLowerCase()
    if (normalized === '') return this.entries
    return this.entries.filter(entry => entry.text.toLocaleLowerCase().includes(normalized))
  }
}
