import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CheckpointStore } from '../src/host/checkpoint/store.ts'
import { SessionCutStore } from '../src/host/checkpoint/cut-store.ts'
import { SessionCleanupRegistry } from '../src/host/session-delete/cleanup.ts'
import {
  createCheckpointCleaner,
  createContextExcludeCleaner,
} from '../src/host/session-delete/plugin-purge.ts'
import { deleteSessionNow, SessionDeleteError } from '../src/host/session-delete/delete.ts'

const sessionId = 'session-01234567-89ab-cdef-0123-456789abcdef' as SessionId

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('SessionCleanupRegistry', () => {
  it('runs registered cleaners and reports failures without aborting siblings', async () => {
    const registry = new SessionCleanupRegistry()
    const ok = vi.fn(async () => undefined)
    const fail = vi.fn(async () => {
      throw new Error('boom')
    })
    registry.register({ id: 'ok', label: 'ok', purge: ok })
    registry.register({ id: 'fail', label: 'fail', purge: fail })
    const reports = await registry.purgeAll(sessionId, new AbortController().signal)
    expect(ok).toHaveBeenCalledOnce()
    expect(fail).toHaveBeenCalledOnce()
    expect(reports).toEqual([
      { id: 'ok', label: 'ok', ok: true },
      { id: 'fail', label: 'fail', ok: false, detail: 'boom' },
    ])
  })
})

describe('plugin purge cleaners', () => {
  let root = ''

  afterEach(async () => {
    if (root !== '') await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
  })

  it('removes checkpoint store rows and context-exclude files', async () => {
    root = await mkdtemp(join(tmpdir(), 'ae-session-delete-'))
    const checkpointRoot = join(root, 'checkpoint')
    const store = new CheckpointStore(checkpointRoot)
    const cutStore = new SessionCutStore(join(checkpointRoot, 'cuts'))
    await store.replace(sessionId, [])
    // Seed a checkpoint file by writing store schema directly after ensure.
    await mkdir(join(checkpointRoot, 'checkpoints'), { recursive: true })
    await writeFile(join(checkpointRoot, 'checkpoints', `${digest(sessionId)}.json`), JSON.stringify({
      schemaVersion: 1,
      checkpoints: [],
    }), 'utf8')
    await cutStore.set(sessionId, {
      hideTurnsFrom: 1,
      cutSeq: 1,
      restoredAtSeq: 2,
      draftPrompt: '',
      scope: 'conversation',
      previous: null,
    })

    const excludeDir = join(root, 'context-exclude', 'sessions')
    await mkdir(excludeDir, { recursive: true })
    await writeFile(join(excludeDir, `${digest(sessionId)}.json`), '{}', 'utf8')

    const registry = new SessionCleanupRegistry()
    registry.register(createCheckpointCleaner({ store, cutStore, storageRoot: checkpointRoot }))
    registry.register(createContextExcludeCleaner(root))
    const reports = await registry.purgeAll(sessionId, new AbortController().signal)
    expect(reports.every(report => report.ok)).toBe(true)
    expect(await cutStore.get(sessionId)).toBeNull()
    await expect(readFile(join(excludeDir, `${digest(sessionId)}.json`), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('deleteSessionNow', () => {
  it('rejects invalid session ids', async () => {
    const ctx = new Context()
    await expect(deleteSessionNow({
      ctx,
      request: { sessionId: 'not-a-session' as SessionId },
      cleanup: new SessionCleanupRegistry(),
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'INVALID_ID' }) as SessionDeleteError)
    await ctx.fiber.dispose()
  })

  it('rejects busy agents', async () => {
    const ctx = new Context()
    ctx.provide('agents', {
      get: () => ({ status: 'running' }),
    } as never)
    await expect(deleteSessionNow({
      ctx,
      request: { sessionId },
      cleanup: new SessionCleanupRegistry(),
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({ code: 'BUSY' }) as SessionDeleteError)
    await ctx.fiber.dispose()
  })

  it('detaches through workspaceRegistry and erases the session log', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ae-session-delete-live-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const workspaceDir = join(root, 'sessions', 'ws-a')
      await mkdir(join(workspaceDir, sessionId), { recursive: true })
      await writeFile(join(workspaceDir, sessionId, 'marker.txt'), 'x', 'utf8')

      const detachSession = vi.fn(async () => undefined)
      const unpinSession = vi.fn(async () => undefined)
      const unarchiveSession = vi.fn(async () => undefined)
      const ctx = new Context()
      ctx.provide('agents', { get: () => undefined } as never)
      ctx.provide('sessions', { get: () => undefined } as never)
      ctx.provide('workspaceRegistry', {
        archivedSessionIds: [],
        pinnedSessionIds: [sessionId],
        list: () => [{
          id: 'ws-a',
          title: 'Alpha',
          sessionIds: [sessionId],
          detachSession,
        }],
        archiveSession: vi.fn(),
        unarchiveSession,
        unpinSession,
      } as never)

      const result = await deleteSessionNow({
        ctx,
        request: { sessionId },
        cleanup: new SessionCleanupRegistry(),
        signal: new AbortController().signal,
      })
      expect(detachSession).toHaveBeenCalledWith(sessionId)
      expect(unpinSession).toHaveBeenCalledWith(sessionId)
      expect(unarchiveSession).not.toHaveBeenCalled()
      expect(result.registry).toEqual({
        workspaces: ['Alpha'],
        archived: false,
        pinned: true,
      })
      expect(result.removedPaths.some(path => path.includes(sessionId))).toBe(true)
      expect(existsSync(join(workspaceDir, sessionId))).toBe(false)
      await ctx.fiber.dispose()
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
    }
  })
})
