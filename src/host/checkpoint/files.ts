import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CHECKPOINT_SCHEMA_VERSION } from './types.ts'
import type { CheckpointJournal, FileCheckpoint } from './types.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const ABSENT_FILE_HASH = ''
const excludedSegments = new Set(['.git', 'node_modules', '.dsh', 'dist', 'build', 'out', 'coverage', '.next'])
const decoder = new TextDecoder('utf-8', { fatal: true })
const transactionQueues = new Map<string, Promise<void>>()

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = transactionQueues.get(key) ?? Promise.resolve()
  const result = previous.then(operation)
  const tail = result.then(() => undefined, () => undefined)
  transactionQueues.set(key, tail)
  try {
    return await result
  } finally {
    if (transactionQueues.get(key) === tail) transactionQueues.delete(key)
  }
}

export type FileConflictReason = 'unsafe-path' | 'symlink' | 'not-regular-file' | 'binary' | 'too-large' | 'invalid-before-image' | 'hash-mismatch'

export interface FileConflict {
  readonly path: string
  readonly reason: FileConflictReason
  readonly expectedHash?: string
  readonly actualHash?: string | null
}

export class CheckpointFileError extends Error {
  constructor(
    readonly code: 'FILE_CONFLICT' | 'FILE_RESTORE_FAILED',
    readonly conflicts: readonly FileConflict[] = [],
  ) {
    super(code)
    this.name = 'CheckpointFileError'
  }
}

export interface CheckpointJournalStore {
  beginJournal(journal: CheckpointJournal): Promise<void>
  completeJournal(id: string): Promise<void>
  recoverJournal(): Promise<CheckpointJournal[]>
}

export interface RestoreJournal {
  readonly id: string
  readonly status: 'prepared' | 'files-restored' | 'completed' | 'compensated'
  complete(step: string): Promise<void>
  compensate(): Promise<void>
}

export interface CheckpointFileOperations {
  write(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
}

export interface CheckpointFilesOptions {
  readonly workspaceRoot: string
  readonly storageRoot: string
  readonly store: CheckpointJournalStore
  readonly sessionId: SessionId
  readonly checkpointId: string
  readonly createId?: () => string
  readonly now?: () => number
  readonly operations?: CheckpointFileOperations
}

interface FileSnapshot {
  readonly path: string
  readonly exists: boolean
  readonly text: string | null
}

interface Inspection {
  readonly file: FileCheckpoint
  readonly absolutePath: string
  readonly snapshot: FileSnapshot | null
  readonly conflict: FileConflict | null
}

interface StoredFileJournal {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION
  readonly id: string
  readonly snapshots: readonly FileSnapshot[]
  readonly completed: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function unsafePath(path: string): boolean {
  if (!path || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path)) return true
  const segments = path.split(/[\\/]/)
  return segments.some(segment => !segment || segment === '.' || segment === '..'
    || excludedSegments.has(segment.toLowerCase()) || segment.toLowerCase().startsWith('.env'))
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const temporary = join(join(path, '..'), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await removeIfPresent(temporary)
  }
}

class DurableRestoreJournal implements RestoreJournal {
  constructor(
    private readonly options: CheckpointFilesOptions,
    private readonly snapshots: readonly FileSnapshot[],
    readonly id: string,
    private currentStatus: RestoreJournal['status'] = 'prepared',
    private readonly completedPaths: string[] = [],
  ) {}

  get status(): RestoreJournal['status'] {
    return this.currentStatus
  }

  async complete(step: string): Promise<void> {
    if (step !== 'prepared' && step !== 'files-restored' && step !== 'completed' && step !== 'compensated') {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    if (step === 'completed') {
      await this.options.store.completeJournal(this.id)
      this.currentStatus = step
      await removeIfPresent(this.sidecarPath()).catch(() => undefined)
      return
    }
    if (step !== 'compensated') await this.writeSidecar()
    await this.options.store.beginJournal(this.metadata(step))
    this.currentStatus = step
    if (step === 'compensated') await removeIfPresent(this.sidecarPath())
  }

  async compensate(): Promise<void> {
    if (this.currentStatus === 'compensated') return
    if (this.currentStatus === 'completed') throw new CheckpointFileError('FILE_RESTORE_FAILED')
    try {
      for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
        const snapshot = this.snapshots[index]!
        const path = resolve(this.options.workspaceRoot, snapshot.path)
        if (snapshot.exists) await (this.options.operations?.write ?? writeAtomic)(path, snapshot.text!)
        else await (this.options.operations?.remove ?? removeIfPresent)(path)
      }
    } catch {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    await this.complete('compensated')
  }

  async prepare(): Promise<void> {
    await this.writeSidecar()
    await this.options.store.beginJournal(this.metadata('prepared'))
  }

  async recordRestore(path: string): Promise<void> {
    this.completedPaths.push(path)
    await this.writeSidecar()
  }

  private metadata(status: RestoreJournal['status']): CheckpointJournal {
    return {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      id: this.id,
      sessionId: this.options.sessionId,
      checkpointId: this.options.checkpointId,
      status,
      createdAt: (this.options.now ?? Date.now)(),
    }
  }

  private sidecarPath(): string {
    return join(this.options.storageRoot, 'file-journals', `${digest(this.id)}.json`)
  }

  private async writeSidecar(): Promise<void> {
    const value: StoredFileJournal = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      id: this.id,
      snapshots: this.snapshots,
      completed: this.completedPaths,
    }
    await writeAtomic(this.sidecarPath(), JSON.stringify(value))
  }
}

export class CheckpointFiles {
  constructor(private readonly options: CheckpointFilesOptions) {}

  async verifyCurrent(files: readonly FileCheckpoint[]): Promise<FileConflict[]> {
    const inspections = await this.inspect(files)
    return inspections.flatMap(inspection => inspection.conflict ? [inspection.conflict] : [])
  }

  async restoreFiles(files: readonly FileCheckpoint[]): Promise<RestoreJournal> {
    return serialize(this.transactionKey(), () => this.restoreTransaction(files))
  }

  async recoverFiles(): Promise<void> {
    return serialize(this.transactionKey(), () => this.recoverTransaction())
  }

  private transactionKey(): string {
    return `${resolve(this.options.storageRoot)}\0${this.options.sessionId}`
  }

  private async restoreTransaction(files: readonly FileCheckpoint[]): Promise<RestoreJournal> {
    const inspections = await this.inspect(files)
    const conflicts = inspections.flatMap(inspection => inspection.conflict ? [inspection.conflict] : [])
    if (conflicts.length > 0) throw new CheckpointFileError('FILE_CONFLICT', conflicts)
    const snapshots = inspections.map(inspection => inspection.snapshot!)
    const journal = new DurableRestoreJournal(
      this.options,
      snapshots,
      (this.options.createId ?? randomUUID)(),
    )
    try {
      await journal.prepare()
    } catch {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    try {
      for (const inspection of inspections) {
        await this.restore(inspection)
        await journal.recordRestore(inspection.file.path)
      }
      await journal.complete('files-restored')
      return journal
    } catch {
      await journal.compensate()
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
  }

  private async recoverTransaction(): Promise<void> {
    const pending = await this.options.store.recoverJournal()
    for (const metadata of pending) {
      if (metadata.sessionId !== this.options.sessionId) continue
      try {
        const journal = await this.loadJournal(metadata)
        await journal.compensate()
      } catch (error) {
        if (error instanceof CheckpointFileError) throw error
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
    }
  }

  private async loadJournal(metadata: CheckpointJournal): Promise<DurableRestoreJournal> {
    const path = join(this.options.storageRoot, 'file-journals', `${digest(metadata.id)}.json`)
    const stored: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(stored) || stored.schemaVersion !== CHECKPOINT_SCHEMA_VERSION
      || stored.id !== metadata.id || !Array.isArray(stored.snapshots) || !Array.isArray(stored.completed)) {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    const snapshots: FileSnapshot[] = []
    const seen = new Set<string>()
    for (const value of stored.snapshots) {
      if (!isRecord(value) || typeof value.path !== 'string' || typeof value.exists !== 'boolean'
        || unsafePath(value.path) || seen.has(value.path)
        || (value.exists ? typeof value.text !== 'string' : value.text !== null)) {
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      if (value.text !== null && (Buffer.byteLength(value.text as string, 'utf8') > MAX_FILE_BYTES
        || (value.text as string).includes('\0'))) throw new CheckpointFileError('FILE_RESTORE_FAILED')
      seen.add(value.path)
      snapshots.push({ path: value.path, exists: value.exists, text: value.text as string | null })
    }
    const completed: string[] = []
    for (const value of stored.completed) {
      if (typeof value !== 'string' || value !== snapshots[completed.length]?.path) {
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      completed.push(value)
    }
    return new DurableRestoreJournal(this.options, snapshots, metadata.id, metadata.status, completed)
  }

  private async inspect(files: readonly FileCheckpoint[]): Promise<Inspection[]> {
    const inspections: Inspection[] = []
    const seen = new Set<string>()
    for (const file of files) {
      const absolutePath = resolve(this.options.workspaceRoot, file.path)
      let conflict: FileConflict | null = null
      if (unsafePath(file.path) || seen.has(file.path)
        || (absolutePath !== this.options.workspaceRoot && !absolutePath.startsWith(`${resolve(this.options.workspaceRoot)}${sep}`))) {
        conflict = { path: file.path, reason: 'unsafe-path' }
      }
      seen.add(file.path)
      if (conflict === null) conflict = this.validateBeforeImage(file)
      let snapshot: FileSnapshot | null = null
      if (conflict === null) {
        try {
          snapshot = await this.readSnapshot(file.path, absolutePath)
          if (snapshot.exists && snapshot.text === null) {
            conflict = { path: file.path, reason: 'not-regular-file' }
          } else {
            const actualHash = snapshot.exists ? digest(snapshot.text!) : null
            if ((snapshot.exists ? actualHash : ABSENT_FILE_HASH) !== file.afterHash) {
              conflict = { path: file.path, reason: 'hash-mismatch', expectedHash: file.afterHash, actualHash }
            }
          }
        } catch (error) {
          if (isRecord(error) && typeof error.reason === 'string') conflict = { path: file.path, reason: error.reason as FileConflictReason }
          else throw error
        }
      }
      inspections.push({ file, absolutePath, snapshot, conflict })
    }
    return inspections
  }

  private validateBeforeImage(file: FileCheckpoint): FileConflict | null {
    if (file.change === 'create' ? file.beforeText !== null : file.beforeText === null) {
      return { path: file.path, reason: 'invalid-before-image' }
    }
    if (file.beforeText !== null
      && (Buffer.byteLength(file.beforeText, 'utf8') > MAX_FILE_BYTES || file.beforeText.includes('\0'))) {
      return { path: file.path, reason: 'invalid-before-image' }
    }
    return null
  }

  private async readSnapshot(path: string, absolutePath: string): Promise<FileSnapshot> {
    const segments = path.split(/[\\/]/)
    let current = resolve(this.options.workspaceRoot)
    for (const segment of segments) {
      current = join(current, segment)
      let stats
      try {
        stats = await lstat(current)
      } catch (error) {
        if (isMissing(error)) return { path, exists: false, text: null }
        throw error
      }
      if (stats.isSymbolicLink()) throw { path, reason: 'symlink' }
      if (current !== absolutePath) {
        if (!stats.isDirectory()) throw { path, reason: 'not-regular-file' }
        continue
      }
      if (!stats.isFile()) throw { path, reason: 'not-regular-file' }
      if (stats.size > MAX_FILE_BYTES) throw { path, reason: 'too-large' }
      const contents = await readFile(current)
      if (contents.includes(0)) throw { path, reason: 'binary' }
      try {
        return { path, exists: true, text: decoder.decode(contents) }
      } catch {
        throw { path, reason: 'binary' }
      }
    }
    return { path, exists: false, text: null }
  }

  private async restore(inspection: Inspection): Promise<void> {
    if (inspection.file.change === 'create') {
      await (this.options.operations?.remove ?? removeIfPresent)(inspection.absolutePath)
    } else {
      await (this.options.operations?.write ?? writeAtomic)(inspection.absolutePath, inspection.file.beforeText!)
    }
  }
}
