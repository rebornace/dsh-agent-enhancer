import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointFiles } from '../src/host/checkpoint/files.ts'
import type { CheckpointFileOperations } from '../src/host/checkpoint/files.ts'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import type { FileCheckpoint } from '../src/host/checkpoint/types.ts'

const roots: string[] = []
const sessionId = SessionId('session-1')
let root: string
let workspaceRoot: string
let storageRoot: string

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function checkpointFile(
  path: string,
  change: FileCheckpoint['change'],
  beforeText: string | null,
  afterText: string | null,
): FileCheckpoint {
  return {
    path,
    change,
    beforeText,
    beforeHash: beforeText === null ? '' : digest(beforeText),
    afterHash: afterText === null ? '' : digest(afterText),
  }
}

function manager(operations?: CheckpointFileOperations, id = 'restore-1'): CheckpointFiles {
  return new CheckpointFiles({
    workspaceRoot,
    storageRoot,
    store: new CheckpointStore(storageRoot),
    sessionId,
    checkpointId: 'checkpoint-1',
    createId: () => id,
    now: () => 1_234,
    operations,
  })
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-files-'))
  roots.push(root)
  workspaceRoot = join(root, 'workspace')
  storageRoot = join(root, 'storage')
  await mkdir(workspaceRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('CheckpointFiles', () => {
  it('restores a created file by deleting it', async () => {
    const path = join(workspaceRoot, 'created.txt')
    await writeFile(path, 'after', 'utf8')
    const file = checkpointFile('created.txt', 'create', null, 'after')

    await expect(manager().verifyCurrent([file])).resolves.toEqual([])
    const journal = await manager().restoreFiles([file])

    await expectMissing(path)
    expect(journal.status).toBe('files-restored')
  })

  it('restores a modified file from its before-image', async () => {
    const path = join(workspaceRoot, 'modified.txt')
    await writeFile(path, 'after', 'utf8')
    const file = checkpointFile('modified.txt', 'modify', 'before', 'after')

    await manager().restoreFiles([file])

    await expect(readFile(path, 'utf8')).resolves.toBe('before')
  })

  it('recreates a deleted file and its missing parent directories', async () => {
    const path = join(workspaceRoot, 'nested', 'deleted.txt')
    const file = checkpointFile('nested/deleted.txt', 'delete', 'before', null)

    await manager().restoreFiles([file])

    await expect(readFile(path, 'utf8')).resolves.toBe('before')
  })

  it('restores create, modify, and delete together across multiple files', async () => {
    await writeFile(join(workspaceRoot, 'created.txt'), 'created after', 'utf8')
    await writeFile(join(workspaceRoot, 'modified.txt'), 'modified after', 'utf8')
    const files = [
      checkpointFile('created.txt', 'create', null, 'created after'),
      checkpointFile('modified.txt', 'modify', 'modified before', 'modified after'),
      checkpointFile('deleted.txt', 'delete', 'deleted before', null),
    ]

    await manager().restoreFiles(files)

    await expectMissing(join(workspaceRoot, 'created.txt'))
    await expect(readFile(join(workspaceRoot, 'modified.txt'), 'utf8')).resolves.toBe('modified before')
    await expect(readFile(join(workspaceRoot, 'deleted.txt'), 'utf8')).resolves.toBe('deleted before')
  })

  it('rejects the whole restore when any afterHash conflicts and writes no journal', async () => {
    const firstPath = join(workspaceRoot, 'first.txt')
    const secondPath = join(workspaceRoot, 'second.txt')
    await writeFile(firstPath, 'first after', 'utf8')
    await writeFile(secondPath, 'concurrent edit', 'utf8')
    const files = [
      checkpointFile('first.txt', 'modify', 'first before', 'first after'),
      checkpointFile('second.txt', 'modify', 'second before', 'second after'),
    ]
    const filesManager = manager()

    await expect(filesManager.verifyCurrent(files)).resolves.toEqual([
      { path: 'second.txt', reason: 'hash-mismatch', expectedHash: digest('second after'), actualHash: digest('concurrent edit') },
    ])
    await expect(filesManager.restoreFiles(files)).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    await expect(readFile(firstPath, 'utf8')).resolves.toBe('first after')
    await expect(readFile(secondPath, 'utf8')).resolves.toBe('concurrent edit')
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toEqual([])
  })

  it.each([
    { name: 'absolute path', path: '/outside.txt', reason: 'unsafe-path' },
    { name: 'parent traversal', path: '../outside.txt', reason: 'unsafe-path' },
    { name: 'environment file', path: '.env', reason: 'unsafe-path' },
    { name: 'Git metadata', path: '.git/config', reason: 'unsafe-path' },
    { name: 'dependencies', path: 'node_modules/pkg/index.js', reason: 'unsafe-path' },
    { name: 'plugin state', path: '.dsh/state.json', reason: 'unsafe-path' },
    { name: 'build output', path: 'dist/index.js', reason: 'unsafe-path' },
  ])('rejects $name without writing', async ({ path: unsafePath, reason }) => {
    const file = checkpointFile(unsafePath, 'delete', 'before', null)
    const filesManager = manager()

    await expect(filesManager.verifyCurrent([file])).resolves.toMatchObject([{ path: unsafePath, reason }])
    await expect(filesManager.restoreFiles([file])).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
  })

  it('rejects binary current content', async () => {
    const path = join(workspaceRoot, 'binary.dat')
    await writeFile(path, Buffer.from([0x41, 0x00, 0x42]))
    const file = checkpointFile('binary.dat', 'modify', 'before', 'ignored')

    await expect(manager().verifyCurrent([file])).resolves.toMatchObject([{ path: 'binary.dat', reason: 'binary' }])
    await expect(readFile(path)).resolves.toEqual(Buffer.from([0x41, 0x00, 0x42]))
  })

  it('rejects current content over 2 MiB', async () => {
    const path = join(workspaceRoot, 'large.txt')
    await writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    const file = checkpointFile('large.txt', 'modify', 'before', 'ignored')

    await expect(manager().verifyCurrent([file])).resolves.toMatchObject([{ path: 'large.txt', reason: 'too-large' }])
  })

  it.runIf(process.platform !== 'win32')('rejects a symbolic link even when its target is inside the workspace', async () => {
    const target = join(workspaceRoot, 'target.txt')
    const link = join(workspaceRoot, 'linked.txt')
    await writeFile(target, 'after', 'utf8')
    await symlink(target, link)
    const file = checkpointFile('linked.txt', 'modify', 'before', 'after')

    await expect(manager().verifyCurrent([file])).resolves.toMatchObject([{ path: 'linked.txt', reason: 'symlink' }])
    await expect(manager().restoreFiles([file])).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    await expect(readFile(target, 'utf8')).resolves.toBe('after')
  })

  it('rejects a symbolic-link parent that escapes the workspace', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'file.txt'), 'after', 'utf8')
    await symlink(outside, join(workspaceRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const file = checkpointFile('escape/file.txt', 'modify', 'before', 'after')

    await expect(manager().verifyCurrent([file])).resolves.toMatchObject([{ path: 'escape/file.txt', reason: 'symlink' }])
    await expect(manager().restoreFiles([file])).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    await expect(readFile(join(outside, 'file.txt'), 'utf8')).resolves.toBe('after')
  })

  it.each([1, 2, 3])('compensates every file when restore step %i fails', async failureAt => {
    await writeFile(join(workspaceRoot, 'modified.txt'), 'modified after', 'utf8')
    await writeFile(join(workspaceRoot, 'created.txt'), 'created after', 'utf8')
    const files = [
      checkpointFile('modified.txt', 'modify', 'modified before', 'modified after'),
      checkpointFile('created.txt', 'create', null, 'created after'),
      checkpointFile('deleted.txt', 'delete', 'deleted before', null),
    ]
    let attempts = 0
    const failAtStep = async (operation: () => Promise<void>) => {
      attempts += 1
      if (attempts === failureAt) throw new Error(`injected failure ${failureAt}`)
      await operation()
    }

    await expect(manager({
      write: (path, text) => failAtStep(() => writeFile(path, text, 'utf8')),
      remove: path => failAtStep(() => rm(path, { force: true })),
    }).restoreFiles(files)).rejects.toMatchObject({ code: 'FILE_RESTORE_FAILED' })

    await expect(readFile(join(workspaceRoot, 'modified.txt'), 'utf8')).resolves.toBe('modified after')
    await expect(readFile(join(workspaceRoot, 'created.txt'), 'utf8')).resolves.toBe('created after')
    await expectMissing(join(workspaceRoot, 'deleted.txt'))
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toEqual([])
  })

  it('compensates restored files when the later Session step fails', async () => {
    const path = join(workspaceRoot, 'modified.txt')
    await writeFile(path, 'after', 'utf8')
    const file = checkpointFile('modified.txt', 'modify', 'before', 'after')
    const journal = await manager().restoreFiles([file])
    await expect(readFile(path, 'utf8')).resolves.toBe('before')

    await journal.compensate()

    expect(journal.status).toBe('compensated')
    await expect(readFile(path, 'utf8')).resolves.toBe('after')
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toEqual([])
  })

  it('keeps restored files and closes the journal only after the Session step completes', async () => {
    const path = join(workspaceRoot, 'modified.txt')
    await writeFile(path, 'after', 'utf8')
    const file = checkpointFile('modified.txt', 'modify', 'before', 'after')
    const store = new CheckpointStore(storageRoot)
    const journal = await manager().restoreFiles([file])

    await journal.complete('completed')

    expect(journal.status).toBe('completed')
    await expect(readFile(path, 'utf8')).resolves.toBe('before')
    await expect(store.recoverJournal()).resolves.toEqual([])
  })

  it('does not reopen a committed transaction when sidecar cleanup fails', async () => {
    const path = join(workspaceRoot, 'modified.txt')
    await writeFile(path, 'after', 'utf8')
    const file = checkpointFile('modified.txt', 'modify', 'before', 'after')
    const journal = await manager().restoreFiles([file])
    const sidecar = join(storageRoot, 'file-journals', `${digest('restore-1')}.json`)
    await rm(sidecar)
    await mkdir(sidecar)

    await expect(journal.complete('completed')).resolves.toBeUndefined()

    expect(journal.status).toBe('completed')
    await expect(readFile(path, 'utf8')).resolves.toBe('before')
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toEqual([])
  })

  it('recovers a files-restored crash by restoring the pre-restore image', async () => {
    const path = join(workspaceRoot, 'modified.txt')
    await writeFile(path, 'after', 'utf8')
    const file = checkpointFile('modified.txt', 'modify', 'before', 'after')
    await manager().restoreFiles([file])
    await expect(readFile(path, 'utf8')).resolves.toBe('before')

    await manager().recoverFiles()

    await expect(readFile(path, 'utf8')).resolves.toBe('after')
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toEqual([])
  })

  it('leaves a failed compensation pending and finishes it during recovery', async () => {
    await writeFile(join(workspaceRoot, 'first.txt'), 'first after', 'utf8')
    await writeFile(join(workspaceRoot, 'second.txt'), 'second after', 'utf8')
    const files = [
      checkpointFile('first.txt', 'modify', 'first before', 'first after'),
      checkpointFile('second.txt', 'modify', 'second before', 'second after'),
    ]
    let attempts = 0
    let restoreFailed = false
    let compensationFailures = 0
    const inject = async (operation: () => Promise<void>) => {
      attempts += 1
      if (attempts === 2) {
        restoreFailed = true
        throw new Error('injected restore failure')
      }
      if (restoreFailed && compensationFailures === 0) {
        compensationFailures += 1
        throw new Error('injected compensation failure')
      }
      await operation()
    }
    const failing = manager({
      write: (path, text) => inject(() => writeFile(path, text, 'utf8')),
      remove: path => inject(() => rm(path, { force: true })),
    })

    await expect(failing.restoreFiles(files)).rejects.toMatchObject({ code: 'FILE_RESTORE_FAILED' })
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toMatchObject([{ status: 'prepared' }])

    await manager().recoverFiles()

    await expect(readFile(join(workspaceRoot, 'first.txt'), 'utf8')).resolves.toBe('first after')
    await expect(readFile(join(workspaceRoot, 'second.txt'), 'utf8')).resolves.toBe('second after')
    await expect(new CheckpointStore(storageRoot).recoverJournal()).resolves.toEqual([])
  })

  it('durably records each completed file step in restore order', async () => {
    await writeFile(join(workspaceRoot, 'modified.txt'), 'modified after', 'utf8')
    await writeFile(join(workspaceRoot, 'created.txt'), 'created after', 'utf8')
    const files = [
      checkpointFile('modified.txt', 'modify', 'modified before', 'modified after'),
      checkpointFile('created.txt', 'create', null, 'created after'),
      checkpointFile('deleted.txt', 'delete', 'deleted before', null),
    ]

    await manager().restoreFiles(files)

    const sidecar = join(storageRoot, 'file-journals', `${digest('restore-1')}.json`)
    const stored = JSON.parse(await readFile(sidecar, 'utf8')) as unknown
    expect(stored).toMatchObject({
      id: 'restore-1',
      completed: ['modified.txt', 'created.txt', 'deleted.txt'],
    })
  })

  it('serializes file transactions for one Session across manager instances', async () => {
    await writeFile(join(workspaceRoot, 'first.txt'), 'first after', 'utf8')
    await writeFile(join(workspaceRoot, 'second.txt'), 'second after', 'utf8')
    const first = checkpointFile('first.txt', 'modify', 'first before', 'first after')
    const second = checkpointFile('second.txt', 'modify', 'second before', 'second after')
    let active = 0
    let maximumActive = 0
    const operations: CheckpointFileOperations = {
      write: async (path, text) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          await new Promise<void>(resolve => { setTimeout(resolve, 25) })
          await writeFile(path, text, 'utf8')
        } finally {
          active -= 1
        }
      },
      remove: path => rm(path, { force: true }),
    }

    const journals = await Promise.all([
      manager(operations, 'restore-1').restoreFiles([first]),
      manager(operations, 'restore-2').restoreFiles([second]),
    ])

    expect(maximumActive).toBe(1)
    await Promise.all(journals.map(journal => journal.complete('completed')))
  })
})
