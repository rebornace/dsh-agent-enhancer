import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import { CHECKPOINT_SCHEMA_VERSION } from './types.ts'
import type { Checkpoint, CheckpointJournal } from './types.ts'

const MAX_CHECKPOINTS = 20
const checkpointQueues = new Map<string, Promise<void>>()
const journalQueues = new Map<string, Promise<void>>()

async function serialize<T>(queues: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
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
const gapSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), reason: z.literal('non-text-content') }).strict(),
  z.object({ type: z.literal('workspace'), reason: z.literal('capture-failed') }).strict(),
])
const fileSchema = z.object({
  path: z.string().min(1),
  change: z.enum(['create', 'modify', 'delete']),
  beforeText: z.string().nullable(),
  beforeHash: z.string(),
  afterText: z.string().nullable(),
  afterHash: z.string(),
}).strict().superRefine((file, context) => {
  const validBefore = file.change === 'create' ? file.beforeText === null : file.beforeText !== null
  if (!validBefore) context.addIssue({ code: 'custom', path: ['beforeText'], message: 'Invalid before-image' })
  const validAfter = file.change === 'delete' ? file.afterText === null : file.afterText !== null
  if (!validAfter) context.addIssue({ code: 'custom', path: ['afterText'], message: 'Invalid after-image' })
})
const checkpointSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  pluginVersion: z.string().min(1),
  id: z.string().min(1),
  sessionId: sessionIdSchema,
  session: z.object({ format: z.number().int().positive(), preset: z.string().nullable() }).strict(),
  turn: z.number().int().positive(),
  atSeq: z.number().int().nonnegative(),
  prompt: z.string(),
  createdAt: z.number().int().nonnegative(),
  stage: z.literal('committed'),
  coverage: z.enum(['complete', 'partial']),
  gaps: z.array(gapSchema),
  files: z.array(fileSchema),
}).strict().superRefine((checkpoint, context) => {
  const valid = checkpoint.coverage === 'complete' ? checkpoint.gaps.length === 0 : checkpoint.gaps.length > 0
  if (!valid) context.addIssue({ code: 'custom', path: ['gaps'], message: 'Coverage does not match gaps' })
})
const storeSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  checkpoints: z.array(checkpointSchema).max(MAX_CHECKPOINTS),
}).strict()
const journalSchema = z.object({
  schemaVersion: z.literal(CHECKPOINT_SCHEMA_VERSION),
  id: z.string().min(1),
  sessionId: sessionIdSchema,
  checkpointId: z.string().min(1),
  status: z.enum(['prepared', 'files-restored', 'completed', 'compensated']),
  createdAt: z.number().int().nonnegative(),
}).strict()

export type CheckpointStoreErrorCode = 'INVALID_CHECKPOINT' | 'INVALID_JOURNAL' | 'INVALID_STORE' | 'INCOMPATIBLE_SCHEMA'

export class CheckpointStoreError extends Error {
  constructor(readonly code: CheckpointStoreErrorCode) {
    super(code)
    this.name = 'CheckpointStoreError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT'
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertCheckpointSchema(value: unknown): void {
  if (isRecord(value) && value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new CheckpointStoreError('INCOMPATIBLE_SCHEMA')
  }
}

function assertStoredSchema(value: unknown): void {
  if (!isRecord(value)) return
  assertCheckpointSchema(value)
  if (Array.isArray(value.checkpoints)) {
    for (const checkpoint of value.checkpoints) assertCheckpointSchema(checkpoint)
  }
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

export class CheckpointStore {
  private readonly checkpointDirectory: string
  private readonly journalDirectory: string
  private readonly rootKey: string

  constructor(private readonly root: string) {
    this.checkpointDirectory = join(root, 'checkpoints')
    this.journalDirectory = join(root, 'journals')
    this.rootKey = join(root, '.')
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    assertCheckpointSchema(checkpoint)
    const parsed = checkpointSchema.safeParse(checkpoint)
    if (!parsed.success) throw new CheckpointStoreError('INVALID_CHECKPOINT')
    await serialize(checkpointQueues, this.checkpointKey(checkpoint.sessionId), async () => {
      const checkpoints = await this.list(checkpoint.sessionId)
      const existing = checkpoints.findIndex(value => value.id === checkpoint.id)
      if (existing >= 0) checkpoints.splice(existing, 1, parsed.data)
      else checkpoints.push(parsed.data)
      checkpoints.sort((left, right) => left.createdAt - right.createdAt || left.turn - right.turn || left.id.localeCompare(right.id))
      await this.ensureDirectories()
      await writeAtomic(this.checkpointPath(checkpoint.sessionId), {
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        checkpoints: checkpoints.slice(-MAX_CHECKPOINTS),
      })
    })
  }

  async list(sessionId: SessionId): Promise<Checkpoint[]> {
    await this.ensureDirectories()
    let stored: unknown
    try {
      stored = await this.readJson(this.checkpointPath(sessionId))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    assertStoredSchema(stored)
    const parsed = storeSchema.safeParse(stored)
    if (!parsed.success) throw new CheckpointStoreError('INVALID_STORE')
    return parsed.data.checkpoints
  }

  async recoverInterruptedWrites(sessionId: SessionId): Promise<void> {
    await serialize(checkpointQueues, this.checkpointKey(sessionId), async () => {
      await this.ensureDirectories()
      const prefix = `.${basename(this.checkpointPath(sessionId))}.`
      await this.cleanTemporaryFiles(this.checkpointDirectory, prefix)
    })
  }

  async beginJournal(journal: CheckpointJournal): Promise<void> {
    assertCheckpointSchema(journal)
    const parsed = journalSchema.safeParse(journal)
    if (!parsed.success) throw new CheckpointStoreError('INVALID_JOURNAL')
    await serialize(journalQueues, this.rootKey, async () => {
      await this.ensureDirectories()
      await writeAtomic(join(this.journalDirectory, `${digest(journal.id)}.json`), parsed.data)
    })
  }

  async completeJournal(id: string): Promise<void> {
    await serialize(journalQueues, this.rootKey, async () => {
      await this.ensureDirectories()
      await removeIfPresent(join(this.journalDirectory, `${digest(id)}.json`))
    })
  }

  async listPendingJournals(): Promise<CheckpointJournal[]> {
    return this.readPendingJournals()
  }

  async recoverJournal(): Promise<CheckpointJournal[]> {
    return serialize(journalQueues, this.rootKey, async () => {
      await this.ensureDirectories()
      await this.cleanTemporaryFiles(this.journalDirectory)
      return this.readPendingJournals()
    })
  }

  private async readPendingJournals(): Promise<CheckpointJournal[]> {
    let names: string[]
    try {
      names = await readdir(this.journalDirectory)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    const journals: CheckpointJournal[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const stored = await this.readJson(join(this.journalDirectory, name))
      assertCheckpointSchema(stored)
      const parsed = journalSchema.safeParse(stored)
      if (!parsed.success) throw new CheckpointStoreError('INVALID_STORE')
      if (parsed.data.status === 'prepared' || parsed.data.status === 'files-restored') journals.push(parsed.data)
    }
    return journals.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
  }

  private checkpointKey(sessionId: SessionId): string {
    return `${this.rootKey}\0${sessionId}`
  }

  private checkpointPath(sessionId: SessionId): string {
    return join(this.checkpointDirectory, `${digest(sessionId)}.json`)
  }

  private async ensureDirectories(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(this.checkpointDirectory, { recursive: true, mode: 0o700 })
    await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 })
  }

  private async cleanTemporaryFiles(directory: string, prefix = ''): Promise<void> {
    for (const name of await readdir(directory)) {
      if (name.startsWith(prefix) && name.endsWith('.tmp')) await unlink(join(directory, name))
    }
  }

  private async readJson(path: string): Promise<unknown> {
    const text = await readFile(path, 'utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new CheckpointStoreError('INVALID_STORE')
    }
  }
}
