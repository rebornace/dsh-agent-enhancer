import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Per-session plugin persistence cleaner.
 *
 * **Principle:** any new feature that writes data keyed by `sessionId` must
 * register a cleaner here in the same change set (see
 * `docs/architecture/session-delete.md` and `AGENTS.md`).
 */
export interface SessionCleaner {
  readonly id: string
  readonly label: string
  purge(sessionId: SessionId, signal: AbortSignal): Promise<void>
}

export interface SessionCleanerReport {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail?: string
}

export class SessionCleanupRegistry {
  private readonly cleaners = new Map<string, SessionCleaner>()

  register(cleaner: SessionCleaner): () => void {
    if (cleaner.id.trim() === '') throw new Error('SessionCleaner.id must be non-empty')
    this.cleaners.set(cleaner.id, cleaner)
    return () => {
      const current = this.cleaners.get(cleaner.id)
      if (current === cleaner) this.cleaners.delete(cleaner.id)
    }
  }

  list(): readonly SessionCleaner[] {
    return [...this.cleaners.values()]
  }

  async purgeAll(sessionId: SessionId, signal: AbortSignal): Promise<readonly SessionCleanerReport[]> {
    const reports: SessionCleanerReport[] = []
    for (const cleaner of this.cleaners.values()) {
      signal.throwIfAborted()
      try {
        await cleaner.purge(sessionId, signal)
        reports.push({ id: cleaner.id, label: cleaner.label, ok: true })
      } catch (error) {
        reports.push({
          id: cleaner.id,
          label: cleaner.label,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return reports
  }
}
