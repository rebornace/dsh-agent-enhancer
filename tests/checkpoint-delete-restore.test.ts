import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chainTrackedFiles, netFileChange } from '../src/host/checkpoint/chain-files.ts'
import { CheckpointFiles } from '../src/host/checkpoint/files.ts'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import type { Checkpoint, FileCheckpoint } from '../src/host/checkpoint/types.ts'

const roots: string[] = []
let workspaceRoot: string
let storageRoot: string

function digest(value: string | null): string {
  return value === null ? '' : createHash('sha256').update(value).digest('hex')
}

function file(
  path: string,
  change: FileCheckpoint['change'],
  before: string | null,
  after: string | null,
): FileCheckpoint {
  return {
    path,
    change,
    beforeText: before,
    beforeHash: digest(before),
    afterText: after,
    afterHash: digest(after),
  }
}

function checkpoint(turn: number, files: readonly FileCheckpoint[]): Checkpoint {
  return {
    schemaVersion: 1,
    pluginVersion: 'test',
    id: `cp-${turn}`,
    sessionId: SessionId('session-1'),
    session: { format: 1, preset: null },
    turn,
    atSeq: turn * 10,
    prompt: `prompt ${turn}`,
    createdAt: turn,
    stage: 'committed',
    coverage: 'complete',
    gaps: [],
    files,
  }
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-del-restore-'))
  roots.push(root)
  workspaceRoot = join(root, 'workspace')
  storageRoot = join(root, 'storage')
  await mkdir(workspaceRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('delete restore', () => {
  it('recreates an empty deleted file on rollback', async () => {
    const files = new CheckpointFiles({
      workspaceRoot,
      storageRoot,
      store: new CheckpointStore(storageRoot),
      sessionId: SessionId('session-1'),
      checkpointId: 'c1',
      createId: () => 'j1',
    })
    await files.runTransaction([file('1.txt', 'delete', '', null)], async () => ({
      appended: true,
      synchronized: true,
    }))
    await expect(readFile(join(workspaceRoot, '1.txt'), 'utf8')).resolves.toBe('')
  })

  it('omits create-then-delete net no-ops from the restore chain', () => {
    const chained = chainTrackedFiles([
      checkpoint(26, [file('1.txt', 'create', null, '')]),
      checkpoint(28, [file('1.txt', 'delete', '', null)]),
    ], 26)
    expect(chained).toEqual([])
  })

  it('still restores a lone delete after a prior create outside the chain', () => {
    const chained = chainTrackedFiles([
      checkpoint(26, [file('1.txt', 'create', null, '')]),
      checkpoint(28, [file('1.txt', 'delete', '', null)]),
    ], 28)
    expect(chained).toEqual([file('1.txt', 'delete', '', null)])
  })

  it('nets modify-then-delete as delete with the earliest before-image', () => {
    expect(netFileChange(
      file('a.ts', 'modify', 'v0', 'v1'),
      file('a.ts', 'delete', 'v1', null),
    )).toBe('delete')
    const chained = chainTrackedFiles([
      checkpoint(1, [file('a.ts', 'modify', 'v0', 'v1')]),
      checkpoint(2, [file('a.ts', 'delete', 'v1', null)]),
    ], 1)
    expect(chained).toEqual([file('a.ts', 'delete', 'v0', null)])
  })

  it('rejects the legacy create-then-delete invalid create row', async () => {
    const files = new CheckpointFiles({
      workspaceRoot,
      storageRoot,
      store: new CheckpointStore(storageRoot),
      sessionId: SessionId('session-1'),
      checkpointId: 'c1',
      createId: () => 'j1',
    })
    const invalid = {
      path: '1.txt',
      change: 'create' as const,
      beforeText: null,
      beforeHash: '',
      afterText: null,
      afterHash: '',
    }
    await expect(files.verifyCurrent([invalid], 'rollback')).resolves.toMatchObject([
      { path: '1.txt', reason: 'invalid-after-image' },
    ])
  })
})
