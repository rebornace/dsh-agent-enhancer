import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it, vi } from 'vitest'
import type { CheckpointRollbackRequest } from '../src/host/checkpoint/service.ts'
import {
  checkpointClientRemoteInfo,
  CheckpointRollbackClientError,
  checkpointRollbackRemote,
} from '../src/client/rollback/remote.ts'

const request: CheckpointRollbackRequest = { sessionId: 'session-1' as SessionId, turn: 2 }

describe('checkpoint rollback Client Remote', () => {
  it('declares only preview and execute with cancellation and strict result codecs', () => {
    expect(checkpointClientRemoteInfo.descriptors).toHaveLength(2)
    expect(checkpointClientRemoteInfo.descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        namespace: 'checkpointRollback', method: 'preview', service: 'checkpointRollback',
        cancellation: { parameter: 'signal' },
      }),
      expect.objectContaining({
        namespace: 'checkpointRollback', method: 'execute', service: 'checkpointRollback',
        cancellation: { parameter: 'signal' },
      }),
    ]))
    for (const descriptor of checkpointClientRemoteInfo.descriptors) {
      expect(descriptor.parameters).toHaveLength(1)
      expect(descriptor.parameters[0]).toMatchObject({ name: 'request', source: 'json' })
      expect(descriptor.result.mode).toBe('strict')
    }
  })

  it('invokes the mounted namespace without exposing Host files or Session logs', async () => {
    const preview = vi.fn(async () => ({
      ok: true as const,
      value: { sessionId: request.sessionId, turn: 2, messages: [], files: [], conflicts: [], unavailable: [] },
    }))
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { sessionId: request.sessionId, turn: 2, draft: 'editable prompt' },
    }))
    const remote = { checkpointRollback: { preview, execute } }
    const signal = new AbortController().signal

    await expect(checkpointRollbackRemote.preview(remote, request, signal)).resolves.toMatchObject({ turn: 2 })
    await expect(checkpointRollbackRemote.execute(remote, request, signal)).resolves.toEqual({
      sessionId: request.sessionId, turn: 2, draft: 'editable prompt',
    })
    expect(preview).toHaveBeenCalledWith(request, signal)
    expect(execute).toHaveBeenCalledWith(request, signal)
  })

  it('preserves stable rollback categories and hides transport details', async () => {
    const remote = {
      checkpointRollback: {
        preview: async () => ({
          ok: false as const,
          error: {
            code: 'agent-enhancer/rollback-failed',
            message: 'private path and provider details',
            details: { code: 'ROLLBACK_CONFLICT' },
          },
        }),
      },
    }

    const rejection = await checkpointRollbackRemote.preview(remote, request).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(CheckpointRollbackClientError)
    expect(rejection).toMatchObject({ code: 'ROLLBACK_CONFLICT' })
    expect((rejection as Error).message).not.toContain('private path')
  })

  it('rethrows cancellation unchanged', async () => {
    const controller = new AbortController()
    controller.abort()
    const remote = {
      checkpointRollback: {
        execute: async () => { throw controller.signal.reason },
      },
    }

    const rejection = await checkpointRollbackRemote.execute(remote, request, controller.signal)
      .catch((error: unknown) => error)
    expect(rejection).toBe(controller.signal.reason)
    expect(rejection).toMatchObject({ name: 'AbortError' })
  })
})
