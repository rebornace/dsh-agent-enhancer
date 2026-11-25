import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface CursorStore {
  get(): string
  set(next: string): void
}

export interface CursorFileOptions {
  /** Null keeps the cursor in memory (tests, or a host without plugin-data). */
  readonly filePath: string | null
  readonly initial?: string
}

interface FileShape {
  readonly version: 1
  readonly cursor: string
}

function load(filePath: string, fallback: string): string {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<FileShape>
    return parsed.version === 1 && typeof parsed.cursor === 'string' ? parsed.cursor : fallback
  } catch {
    return fallback
  }
}

/**
 * Restart-safe long-poll cursor.
 *
 * Losing it costs duplicate deliveries, not correctness, so a write failure is
 * swallowed rather than allowed to stop the adapter. The write itself is
 * temp + rename so a crash cannot leave half a cursor behind.
 */
export function createCursorStore(options: CursorFileOptions): CursorStore {
  const fallback = options.initial ?? ''
  let current = options.filePath === null ? fallback : load(options.filePath, fallback)
  return {
    get: () => current,
    set(next: string) {
      current = next
      if (options.filePath === null) return
      try {
        const shape: FileShape = { version: 1, cursor: next }
        mkdirSync(dirname(options.filePath), { recursive: true })
        const tmp = `${options.filePath}.tmp`
        writeFileSync(tmp, JSON.stringify(shape))
        renameSync(tmp, options.filePath)
      } catch {
        // Best effort: the in-memory cursor still advances this session.
      }
    },
  }
}
