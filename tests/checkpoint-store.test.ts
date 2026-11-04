import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import type { Checkpoint, CheckpointJournal } from '../src/host/checkpoint/types.ts'

const sessionId = SessionId('session-1')
const roots: string[] = []
let root: string

function checkpoint(turn = 1): Checkpoint {
  return {
    schemaVersion: 1,
    pluginVersion: '0.2.0',
    id: `checkpoint-${turn}`,
    sessionId,
    session: { format: 4, preset: 'default' },
    turn,
    atSeq: turn * 10 - 1,
    prompt: `prompt ${turn}`,
    createdAt: 1_000 + turn,
    stage: 'committed',
    coverage: 'complete',
    gaps: [],
    files: [{
      path: `src/file-${turn}.txt`,
      change: 'modify',
      beforeText: 'before',
      beforeHash: 'before-hash',
      afterText: 'after',
      afterHash: 'after-hash',
    }],
  }
}

function journal(): CheckpointJournal {
  return {
    schemaVersion: 1,
    id: 'journal-1',
    sessionId,
    checkpointId: 'checkpoint-1',
    status: 'prepared',
    createdAt: 1_001,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-checkpoint-store-'))
  roots.push(root)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('CheckpointStore', () => {
  it('round-trips a fully committed checkpoint', async () => {
    const store = new CheckpointStore(root)
    const value = checkpoint()

    await store.save(value)

    await expect(store.list(sessionId)).resolves.toEqual([value])
  })

  it('rejects a checkpoint that has not reached the committed stage', async () => {
    const store = new CheckpointStore(root)
    const pending = { ...checkpoint(), stage: 'preparing' } as unknown as Checkpoint

    await expect(store.save(pending)).rejects.toMatchObject({ code: 'INVALID_CHECKPOINT' })
    await expect(store.list(sessionId)).resolves.toEqual([])
  })

  it('retains only the newest 20 checkpoints for each session', async () => {
    const store = new CheckpointStore(root)

    for (let turn = 1; turn <= 21; turn += 1) await store.save(checkpoint(turn))

    const values = await store.list(sessionId)
    expect(values.map(value => value.turn)).toEqual(Array.from({ length: 20 }, (_, index) => index + 2))
  })

  it('replaces the session list and can clear it', async () => {
    const store = new CheckpointStore(root)
    await store.save(checkpoint(1))
    await store.save(checkpoint(2))
    await store.replace(sessionId, [checkpoint(2)])
    await expect(store.list(sessionId)).resolves.toEqual([checkpoint(2)])
    await store.replace(sessionId, [])
    await expect(store.list(sessionId)).resolves.toEqual([])
  })

  it('purges compensated journals left on disk', async () => {
    const store = new CheckpointStore(root)
    await store.beginJournal(journal())
    await store.beginJournal({ ...journal(), id: 'journal-2', status: 'compensated' })
    await expect(store.purgeSettledJournals()).resolves.toBe(1)
    await expect(store.listPendingJournals()).resolves.toEqual([journal()])
  })

  it('serializes concurrent saves for one Session across store instances', async () => {
    const stores = [new CheckpointStore(root), new CheckpointStore(root)]
    const values = Array.from({ length: 12 }, (_, index) => checkpoint(index + 1))

    await Promise.all(values.map((value, index) => stores[index % stores.length]!.save(value)))

    const stored = await stores[0]!.list(sessionId)
    expect(stored.map(value => value.turn)).toEqual(values.map(value => value.turn))
  })

  it.each([
    {
      name: 'complete coverage with gaps',
      value: { ...checkpoint(), gaps: [{ type: 'workspace', reason: 'capture-failed' }] } as Checkpoint,
    },
    {
      name: 'partial coverage without gaps',
      value: { ...checkpoint(), coverage: 'partial', gaps: [] } as Checkpoint,
    },
    {
      name: 'create with a before-image',
      value: {
        ...checkpoint(),
        files: [{ ...checkpoint().files[0]!, change: 'create', beforeText: 'before' }],
      } as Checkpoint,
    },
    {
      name: 'modify without a before-image',
      value: {
        ...checkpoint(),
        files: [{ ...checkpoint().files[0]!, change: 'modify', beforeText: null }],
      } as Checkpoint,
    },
    {
      name: 'delete without a before-image',
      value: {
        ...checkpoint(),
        files: [{ ...checkpoint().files[0]!, change: 'delete', beforeText: null }],
      } as Checkpoint,
    },
    {
      name: 'legacy checkpoint without an after-image',
      value: {
        ...checkpoint(),
        files: [{
          path: 'src/file-1.txt',
          change: 'modify',
          beforeText: 'before',
          beforeHash: 'before-hash',
          afterHash: 'after-hash',
        }],
      } as unknown as Checkpoint,
    },
  ])('rejects $name in both the disk write and read contracts', async ({ value }) => {
    const store = new CheckpointStore(root)
    const writeError = await store.save(value).then(() => null, error => error as unknown)

    await store.save(checkpoint())
    const directory = join(root, 'checkpoints')
    const name = (await readdir(directory)).find(entry => entry.endsWith('.json'))!
    const path = join(directory, name)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { checkpoints: unknown[] }
    stored.checkpoints[0] = value
    await writeFile(path, JSON.stringify(stored), 'utf8')
    const readError = await store.list(sessionId).then(() => null, error => error as unknown)

    expect(writeError).toMatchObject({ code: 'INVALID_CHECKPOINT' })
    expect(readError).toMatchObject({ code: 'INVALID_STORE' })
  })

  it('rejects an incompatible checkpoint schema before writing it', async () => {
    const store = new CheckpointStore(root)
    const incompatible = { ...checkpoint(), schemaVersion: 2 } as unknown as Checkpoint

    await expect(store.save(incompatible)).rejects.toMatchObject({ code: 'INCOMPATIBLE_SCHEMA' })
    await expect(store.list(sessionId)).resolves.toEqual([])
  })

  it('refuses to read a store with an incompatible schema instead of migrating it', async () => {
    const store = new CheckpointStore(root)
    await store.save(checkpoint())
    const directory = join(root, 'checkpoints')
    const name = (await readdir(directory)).find(entry => entry.endsWith('.json'))!
    const path = join(directory, name)
    const stored = JSON.parse(await readFile(path, 'utf8')) as { schemaVersion: number }
    stored.schemaVersion = 2
    await writeFile(path, JSON.stringify(stored), 'utf8')

    await expect(store.list(sessionId)).rejects.toMatchObject({ code: 'INCOMPATIBLE_SCHEMA' })
  })

  it('writes durable checkpoint data without temporary files and with owner-only permissions', async () => {
    const store = new CheckpointStore(root)

    await store.save(checkpoint())

    const directory = join(root, 'checkpoints')
    const names = await readdir(directory)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/\.json$/)
    expect(names.some(name => name.includes('.tmp'))).toBe(false)
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, names[0]!))).mode & 0o777).toBe(0o600)
    }
  })

  it('never deletes temporary files during normal reads because they may be in flight', async () => {
    const store = new CheckpointStore(root)
    await store.save(checkpoint())
    const directory = join(root, 'checkpoints')
    await writeFile(join(directory, 'active.tmp'), '{ partial json', 'utf8')

    await expect(store.list(sessionId)).resolves.toEqual([checkpoint()])
    expect(await readdir(directory)).toContain('active.tmp')
  })

  it('cleans only the target Session temporary files during explicit recovery', async () => {
    const store = new CheckpointStore(root)
    await store.save(checkpoint())
    const directory = join(root, 'checkpoints')
    const name = (await readdir(directory)).find(entry => entry.endsWith('.json'))!
    const interrupted = `.${name}.interrupted.tmp`
    await writeFile(join(directory, interrupted), '{ partial json', 'utf8')
    await writeFile(join(directory, '.other-session.json.interrupted.tmp'), '{ partial json', 'utf8')

    await store.recoverInterruptedWrites(sessionId)

    await expect(store.list(sessionId)).resolves.toEqual([checkpoint()])
    expect(await readdir(directory)).not.toContain(interrupted)
    expect(await readdir(directory)).toContain('.other-session.json.interrupted.tmp')
  })

  it('recovers pending journals, removes completed ones, and never creates Session logs', async () => {
    const store = new CheckpointStore(root)
    const value = journal()

    await store.beginJournal(value)
    await expect(store.recoverJournal()).resolves.toEqual([value])
    await store.completeJournal(value.id)
    await expect(store.recoverJournal()).resolves.toEqual([])

    const names = await readdir(root)
    expect(names.sort()).toEqual(['checkpoints', 'journals'])
    expect(names.some(name => name.endsWith('.jsonl'))).toBe(false)
  })

  it('discards interrupted journal writes during recovery', async () => {
    const store = new CheckpointStore(root)
    await mkdir(join(root, 'journals'), { recursive: true })
    await writeFile(join(root, 'journals', 'interrupted.tmp'), '{ partial json', 'utf8')

    await expect(store.recoverJournal()).resolves.toEqual([])
    expect(await readdir(join(root, 'journals'))).toEqual([])
  })
})
