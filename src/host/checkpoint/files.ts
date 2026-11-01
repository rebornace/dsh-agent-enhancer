import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep, win32 } from 'node:path'
import { TextDecoder } from 'node:util'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CHECKPOINT_SCHEMA_VERSION } from './types.ts'
import type { CheckpointJournal, FileCheckpoint } from './types.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const ABSENT_FILE_HASH = ''
const excludedSegments = new Set(['.git', 'node_modules', '.dsh', 'dist', 'build', 'out', 'coverage', '.next'])
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
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

export interface SurfaceRestoreResult {
  readonly appended: boolean
  readonly synchronized: boolean
}

export type SurfaceAppendOccurred = (journal: CheckpointJournal) => boolean | Promise<boolean>

interface CurrentSnapshot {
  readonly path: string
  readonly exists: boolean
  readonly text: string | null
}

interface FileSnapshot extends CurrentSnapshot {
  readonly afterHash: string
  readonly beforeHash: string
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

class InspectionFailure extends Error {
  constructor(readonly reason: FileConflictReason) {
    super(reason)
  }
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

function segments(path: string): string[] {
  return path.split(/[\\/]/)
}

function canonicalSegment(segment: string): string {
  return segment.replace(/[. ]+$/g, '').toLowerCase()
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? segments(path).map(canonicalSegment).join('/') : path
}

function unsafePath(path: string): boolean {
  if (!path || path.includes('\0') || isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path)) return true
  return segments(path).some(segment => {
    if (!segment || segment === '.' || segment === '..') return true
    const canonical = canonicalSegment(segment)
    return !canonical || excludedSegments.has(canonical) || canonical === '.env' || canonical.startsWith('.env.')
  })
}

function absolutePath(workspaceRoot: string, path: string): string {
  return resolve(workspaceRoot, ...segments(path))
}

function snapshotHash(snapshot: CurrentSnapshot): string {
  return snapshot.exists ? digest(snapshot.text!) : ABSENT_FILE_HASH
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

async function writeJournalAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temporary = join(join(path, '..'), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    await removeIfPresent(temporary)
  }
}

async function readSnapshot(workspaceRoot: string, path: string): Promise<CurrentSnapshot> {
  let current = resolve(workspaceRoot)
  const target = absolutePath(workspaceRoot, path)
  for (const segment of segments(path)) {
    current = join(current, segment)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if (isMissing(error)) return { path, exists: false, text: null }
      throw error
    }
    if (stats.isSymbolicLink()) throw new InspectionFailure('symlink')
    if (current !== target) {
      if (!stats.isDirectory()) throw new InspectionFailure('not-regular-file')
      continue
    }
    if (!stats.isFile()) throw new InspectionFailure('not-regular-file')
    if (stats.size > MAX_FILE_BYTES) throw new InspectionFailure('too-large')
    const contents = await readFile(current)
    if (contents.includes(0)) throw new InspectionFailure('binary')
    try {
      return { path, exists: true, text: decoder.decode(contents) }
    } catch {
      throw new InspectionFailure('binary')
    }
  }
  return { path, exists: false, text: null }
}

type SnapshotValidator = (snapshot: FileSnapshot) => Promise<void>

class DurableRestoreJournal implements RestoreJournal {
  constructor(
    private readonly options: CheckpointFilesOptions,
    private readonly snapshots: readonly FileSnapshot[],
    readonly id: string,
    private currentStatus: RestoreJournal['status'] = 'prepared',
    private readonly completedPaths: string[] = [],
    private readonly validateSnapshot?: SnapshotValidator,
  ) {}

  get status(): RestoreJournal['status'] {
    return this.currentStatus
  }

  async complete(step: string): Promise<void> {
    if (step === 'files-restored') {
      if (this.currentStatus !== 'prepared') throw new CheckpointFileError('FILE_RESTORE_FAILED')
      await this.writeSidecar()
      await this.options.store.beginJournal(this.metadata(step))
      this.currentStatus = step
      return
    }
    if (step === 'completed') {
      if (this.currentStatus !== 'files-restored') throw new CheckpointFileError('FILE_RESTORE_FAILED')
      await this.options.store.completeJournal(this.id)
      this.currentStatus = step
      await removeIfPresent(this.sidecarPath()).catch(() => undefined)
      return
    }
    throw new CheckpointFileError('FILE_RESTORE_FAILED')
  }

  async compensate(): Promise<void> {
    if (this.currentStatus === 'compensated') return
    if (this.currentStatus !== 'prepared' && this.currentStatus !== 'files-restored') {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    let failed = false
    for (let index = this.snapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = this.snapshots[index]!
      const path = absolutePath(this.options.workspaceRoot, snapshot.path)
      try {
        await this.validateSnapshot?.(snapshot)
        if (snapshot.exists) await (this.options.operations?.write ?? writeAtomic)(path, snapshot.text!)
        else await (this.options.operations?.remove ?? removeIfPresent)(path)
      } catch {
        failed = true
      }
    }
    if (failed) throw new CheckpointFileError('FILE_RESTORE_FAILED')
    await this.options.store.beginJournal(this.metadata('compensated'))
    this.currentStatus = 'compensated'
    await removeIfPresent(this.sidecarPath()).catch(() => undefined)
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
    await writeJournalAtomic(this.sidecarPath(), value)
  }
}

export class CheckpointFiles {
  constructor(private readonly options: CheckpointFilesOptions) {}

  async verifyCurrent(files: readonly FileCheckpoint[]): Promise<FileConflict[]> {
    const inspections = await this.inspect(files)
    return inspections.flatMap(inspection => inspection.conflict ? [inspection.conflict] : [])
  }

  async runTransaction(
    files: readonly FileCheckpoint[],
    restoreSurface: () => Promise<SurfaceRestoreResult>,
  ): Promise<RestoreJournal> {
    return serialize(this.transactionKey(), async () => {
      const journal = await this.restoreFiles(files)
      let result: SurfaceRestoreResult
      try {
        result = await restoreSurface()
      } catch {
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      if (!isRecord(result) || typeof result.appended !== 'boolean' || typeof result.synchronized !== 'boolean') {
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      if (!result.appended) {
        if (result.synchronized) throw new CheckpointFileError('FILE_RESTORE_FAILED')
        await journal.compensate()
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      if (!result.synchronized) throw new CheckpointFileError('FILE_RESTORE_FAILED')
      try {
        await journal.complete('completed')
        return journal
      } catch (error) {
        if (error instanceof CheckpointFileError) throw error
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
    })
  }

  async recoverFiles(surfaceAppendOccurred: SurfaceAppendOccurred): Promise<void> {
    return serialize(this.transactionKey(), async () => {
      const pending = await this.options.store.recoverJournal()
      for (const metadata of pending.reverse()) {
        if (metadata.sessionId !== this.options.sessionId) continue
        try {
          const journal = await this.loadJournal(metadata)
          if (await surfaceAppendOccurred(metadata)) await journal.complete('completed')
          else await journal.compensate()
        } catch (error) {
          if (error instanceof CheckpointFileError) throw error
          throw new CheckpointFileError('FILE_RESTORE_FAILED')
        }
      }
    })
  }

  private transactionKey(): string {
    return `${resolve(this.options.storageRoot)}\0${this.options.sessionId}`
  }

  private async restoreFiles(files: readonly FileCheckpoint[]): Promise<DurableRestoreJournal> {
    let inspections: Inspection[]
    try {
      inspections = await this.inspect(files)
    } catch (error) {
      if (error instanceof CheckpointFileError) throw error
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    const conflicts = inspections.flatMap(inspection => inspection.conflict ? [inspection.conflict] : [])
    if (conflicts.length > 0) throw new CheckpointFileError('FILE_CONFLICT', conflicts)
    const snapshots = inspections.map(inspection => inspection.snapshot!)
    const journal = new DurableRestoreJournal(
      this.options,
      snapshots,
      (this.options.createId ?? randomUUID)(),
      'prepared',
      [],
      snapshot => this.validateCompensationSnapshot(snapshot),
    )
    try {
      await journal.prepare()
    } catch {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
    try {
      for (const inspection of inspections) {
        await this.validateRestoreSnapshot(inspection)
        if (inspection.file.change === 'create') {
          await (this.options.operations?.remove ?? removeIfPresent)(inspection.absolutePath)
        } else {
          await (this.options.operations?.write ?? writeAtomic)(inspection.absolutePath, inspection.file.beforeText!)
        }
        await journal.recordRestore(inspection.file.path)
      }
      await journal.complete('files-restored')
      return journal
    } catch {
      await journal.compensate()
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
    }
  }

  private async validateRestoreSnapshot(inspection: Inspection): Promise<void> {
    const current = await readSnapshot(this.options.workspaceRoot, inspection.file.path)
    if (snapshotHash(current) !== inspection.file.afterHash) throw new CheckpointFileError('FILE_RESTORE_FAILED')
  }

  private async validateCompensationSnapshot(snapshot: FileSnapshot): Promise<void> {
    const current = await readSnapshot(this.options.workspaceRoot, snapshot.path)
    const actual = snapshotHash(current)
    if (actual !== snapshot.afterHash && actual !== snapshot.beforeHash) {
      throw new CheckpointFileError('FILE_RESTORE_FAILED')
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
        || typeof value.afterHash !== 'string' || typeof value.beforeHash !== 'string'
        || unsafePath(value.path) || seen.has(pathKey(value.path))
        || (value.exists ? typeof value.text !== 'string' : value.text !== null)) {
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      if (value.text !== null && (Buffer.byteLength(value.text as string, 'utf8') > MAX_FILE_BYTES
        || (value.text as string).includes('\0'))) throw new CheckpointFileError('FILE_RESTORE_FAILED')
      const snapshot: FileSnapshot = {
        path: value.path,
        exists: value.exists,
        text: value.text as string | null,
        afterHash: value.afterHash,
        beforeHash: value.beforeHash,
      }
      if (snapshotHash(snapshot) !== snapshot.afterHash) throw new CheckpointFileError('FILE_RESTORE_FAILED')
      seen.add(pathKey(value.path))
      snapshots.push(snapshot)
    }
    const completed: string[] = []
    for (const value of stored.completed) {
      if (typeof value !== 'string' || value !== snapshots[completed.length]?.path) {
        throw new CheckpointFileError('FILE_RESTORE_FAILED')
      }
      completed.push(value)
    }
    return new DurableRestoreJournal(
      this.options,
      snapshots,
      metadata.id,
      metadata.status,
      completed,
      snapshot => this.validateCompensationSnapshot(snapshot),
    )
  }

  private async inspect(files: readonly FileCheckpoint[]): Promise<Inspection[]> {
    const inspections: Inspection[] = []
    const seen = new Set<string>()
    const root = resolve(this.options.workspaceRoot)
    for (const file of files) {
      const target = absolutePath(this.options.workspaceRoot, file.path)
      let conflict: FileConflict | null = null
      if (unsafePath(file.path) || seen.has(pathKey(file.path))
        || (target !== root && !target.startsWith(`${root}${sep}`))) {
        conflict = { path: file.path, reason: 'unsafe-path' }
      }
      seen.add(pathKey(file.path))
      if (conflict === null) conflict = this.validateBeforeImage(file)
      let snapshot: FileSnapshot | null = null
      if (conflict === null) {
        try {
          const current = await readSnapshot(this.options.workspaceRoot, file.path)
          const actualHash = current.exists ? digest(current.text!) : null
          if (snapshotHash(current) !== file.afterHash) {
            conflict = { path: file.path, reason: 'hash-mismatch', expectedHash: file.afterHash, actualHash }
          } else {
            snapshot = { ...current, afterHash: file.afterHash, beforeHash: file.beforeHash }
          }
        } catch (error) {
          if (error instanceof InspectionFailure) conflict = { path: file.path, reason: error.reason }
          else throw error
        }
      }
      inspections.push({ file, absolutePath: target, snapshot, conflict })
    }
    return inspections
  }

  private validateBeforeImage(file: FileCheckpoint): FileConflict | null {
    const validImage = file.change === 'create'
      ? file.beforeText === null && file.beforeHash === ABSENT_FILE_HASH
      : file.beforeText !== null && digest(file.beforeText) === file.beforeHash
    if (!validImage) return { path: file.path, reason: 'invalid-before-image' }
    if (file.beforeText !== null
      && (Buffer.byteLength(file.beforeText, 'utf8') > MAX_FILE_BYTES || file.beforeText.includes('\0'))) {
      return { path: file.path, reason: 'invalid-before-image' }
    }
    return null
  }
}
