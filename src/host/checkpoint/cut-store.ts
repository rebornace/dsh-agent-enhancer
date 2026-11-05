import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'

const SCHEMA_VERSION = 1 as const
const queues = new Map<string, Promise<void>>()

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const tail = result.then(() => undefined, () => undefined)
  queues.set(key, tail)
  try {
    return await result
  } finally {
    if (queues.get(key) === tail) queues.delete(key)
  }
}

const sessionIdSchema = z.string().min(1).transform(value => value as SessionId)

/** Active restore cut for one session — projection only; DSH log stays append-only. */
export interface SessionCut {
  /** Checkpoint turn the user restored to (cut before this turn). */
  readonly hideTurnsFrom: number
  /** Exclusive: events with seq > cutSeq were withdrawn at restore time. */
  readonly cutSeq: number
  /**
   * Session seq at restore commit. Events with seq > restoredAtSeq are a fresh
   * continuation and must stay visible to chat and the model.
   */
  readonly restoredAtSeq: number
  readonly draftPrompt: string
  readonly scope: 'conversation' | 'conversation-and-files'
  readonly journalId?: string
  /** Previous cut for one-level undo; null means undo clears the cut. */
  readonly previous: SessionCut | null
}

const cutSchema: z.ZodType<SessionCut> = z.lazy(() => z.object({
  hideTurnsFrom: z.number().int().positive(),
  cutSeq: z.number().int().nonnegative(),
  restoredAtSeq: z.number().int().nonnegative(),
  draftPrompt: z.string(),
  scope: z.enum(['conversation', 'conversation-and-files']),
  journalId: z.string().min(1).optional(),
  previous: cutSchema.nullable(),
}).strict())

const fileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  cut: cutSchema.nullable(),
}).strict()

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(join(path, '..'), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await removeIfPresent(temporary)
  }
}

/** True when an event seq sits in the withdrawn window for this cut. */
export function isWithdrawnByCut(cut: SessionCut, seq: number): boolean {
  return seq > cut.cutSeq && seq <= cut.restoredAtSeq
}

export class SessionCutStore {
  private readonly directory: string
  private readonly rootKey: string

  constructor(private readonly root: string) {
    this.directory = join(root, 'sessions')
    this.rootKey = join(root, '.')
  }

  async get(sessionId: SessionId): Promise<SessionCut | null> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.pathOf(sessionId)
    let stored: unknown
    try {
      stored = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
    const parsed = fileSchema.safeParse(stored)
    if (!parsed.success) return null
    return parsed.data.cut
  }

  async set(sessionId: SessionId, cut: SessionCut | null): Promise<SessionCut | null> {
    return serialize(`${this.rootKey}\0${sessionId}`, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = this.pathOf(sessionId)
      if (cut === null) {
        await removeIfPresent(path)
        return null
      }
      await writeAtomic(path, {
        schemaVersion: SCHEMA_VERSION,
        sessionId,
        cut,
      })
      return cut
    })
  }

  private pathOf(sessionId: SessionId): string {
    return join(this.directory, `${digest(sessionId)}.json`)
  }
}
