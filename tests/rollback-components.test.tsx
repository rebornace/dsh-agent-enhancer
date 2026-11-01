// @vitest-environment jsdom
import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CheckpointRollbackPreview,
  CheckpointRollbackRequest,
  CheckpointRollbackResult,
} from '../src/host/checkpoint/service.ts'
import { composerLocales } from '../src/client/locales.ts'
import { RollbackController } from '../src/client/rollback/controller.ts'
import type { RollbackRemote } from '../src/client/rollback/controller.ts'
import { RollbackTurnAction } from '../src/client/rollback/turn-action.tsx'
import type { RollbackTurnActionProps } from '../src/client/rollback/turn-action.tsx'

const sessionId = 'session-1' as SessionId
const controllers: RollbackController[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function preview(overrides: Partial<CheckpointRollbackPreview> = {}): CheckpointRollbackPreview {
  return {
    sessionId,
    turn: 2,
    messages: [
      { seq: 3, type: 'user/message', text: 'second prompt' },
      { seq: 4, type: 'assistant/message', text: 'second response' },
    ],
    files: [{ path: 'src/app.ts', change: 'modify' }],
    conflicts: [],
    unavailable: [],
    ...overrides,
  }
}

function remoteWith(
  previewImplementation: RollbackRemote['preview'] = async () => preview(),
  executeImplementation: RollbackRemote['execute'] = async request => ({
    sessionId: request.sessionId,
    turn: request.turn,
    draft: 'second prompt',
  }),
): RollbackRemote {
  return {
    preview: vi.fn(previewImplementation),
    execute: vi.fn(executeImplementation),
  }
}

function controller(remote: RollbackRemote, enabled = () => true) {
  const value = new RollbackController({ sessionId, enabled, remote })
  controllers.push(value)
  return value
}

function turnFixture(turn = 2, overrides: {
  status?: TurnLocation['status']
  startSeq?: number
  noStart?: boolean
} = {}): TurnLocation {
  const start = overrides.noStart === true ? undefined : {
    seq: overrides.startSeq ?? 2,
    data: { turn },
  }
  return {
    turn,
    start,
    end: overrides.status === 'open' ? undefined : { seq: 5, data: { turn } },
    status: overrides.status ?? 'closed',
    steps: [],
    data: {},
  } as unknown as TurnLocation
}

function translate(key: string, params?: Record<string, unknown>): string {
  const table = composerLocales.en as unknown as Record<string, string>
  let text = table[key] ?? key
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}

function setup(options: {
  enabled?: boolean
  running?: boolean
  canRestore?: boolean
  remote?: RollbackRemote
  turn?: TurnLocation
} = {}) {
  let enabled = options.enabled ?? true
  const remote = options.remote ?? remoteWith()
  const rollback = controller(remote, () => enabled)
  const actions = {
    setDraft: vi.fn(),
    persistDraft: vi.fn(),
    submit: vi.fn(),
  } as unknown as InputActions
  const useAccess = vi.fn((action: string) => action === 'checkpointRollback/execute'
    ? options.canRestore ?? true : true)
  const props = {
    sessionId,
    turn: options.turn ?? turnFixture(),
    seq: 5,
    openFile: vi.fn(),
    inputActions: actions,
    useSession: (selector: (state: { running: boolean }) => unknown) => selector({ running: options.running ?? false }),
    useAccess,
    t: translate,
    rollback,
  } as unknown as RollbackTurnActionProps
  const view = render(<RollbackTurnAction {...props} />)
  return {
    ...view,
    actions,
    rollback,
    remote,
    useAccess,
    setEnabled(value: boolean) {
      enabled = value
      rollback.refreshSettings()
      view.rerender(<RollbackTurnAction {...props} />)
    },
    rerenderTurn(turn: TurnLocation, running = false) {
      const next = {
        ...props,
        turn,
        useSession: (selector: (state: { running: boolean }) => unknown) => selector({ running }),
      } as RollbackTurnActionProps
      view.rerender(<RollbackTurnAction {...next} />)
    },
  }
}

afterEach(() => {
  cleanup()
  for (const rollback of controllers.splice(0)) rollback.dispose()
})

describe('RollbackTurnAction', () => {
  it('has no entry while disabled and shows one only for an eligible closed turn', () => {
    const h = setup({ enabled: false })
    expect(screen.queryByRole('button', { name: 'Roll back to here' })).toBeNull()

    h.setEnabled(true)
    expect(screen.getByRole('button', { name: 'Roll back to here' })).toHaveProperty('disabled', false)
    const reasons = [
      [turnFixture(1, { startSeq: 0 }), 'There is no restorable boundary before the first turn'],
      [turnFixture(2, { noStart: true }), 'The turn start is not loaded'],
      [turnFixture(2, { status: 'open' }), 'The turn is not closed'],
    ] as const
    for (const [ineligible, reason] of reasons) {
      h.rerenderTurn(ineligible)
      expect(screen.getByRole('button', { name: 'Roll back to here' })).toHaveProperty('disabled', true)
      expect(screen.getByRole('button', { name: 'Roll back to here' }).getAttribute('title')).toBe(reason)
    }
    h.rerenderTurn(turnFixture(), true)
    expect(screen.getByRole('button', { name: 'Roll back to here' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Roll back to here' }).getAttribute('title')).toBe('The session is still running')
    h.rerenderTurn(turnFixture())
    expect(screen.getByRole('button', { name: 'Roll back to here' })).toHaveProperty('disabled', false)
  })

  it('uses Slot execute access to disable the entry with a permission reason when available', () => {
    const h = setup({ canRestore: false })
    const button = screen.getByRole('button', { name: 'Roll back to here' })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('title')).toBe('Restore permission is unavailable')
    expect(h.useAccess).toHaveBeenCalledWith('checkpointRollback/execute')
  })

  it('previews messages, tracked files, gaps, and conflicts without writing before confirmation', async () => {
    const remote = remoteWith(async () => preview({
      unavailable: ['workspace-capture-failed', 'prompt-non-text-content'],
      conflicts: [{ path: 'src/app.ts', reason: 'hash-mismatch', expectedHash: 'before', actualHash: 'after' }],
    }))
    const h = setup({ remote })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))

    const dialog = await screen.findByRole('dialog', { name: 'Restore before turn 2' })
    expect(dialog.textContent).toContain('Restore conversation and tracked files')
    expect(dialog.textContent).toContain('second prompt')
    expect(dialog.textContent).toContain('second response')
    expect(dialog.textContent).toContain('src/app.ts')
    expect(dialog.textContent).toContain('Workspace capture is incomplete')
    expect(dialog.textContent).toContain('The original prompt was not plain text')
    expect(dialog.textContent).toContain('File changed after this checkpoint')
    expect(dialog.textContent).not.toContain('complete world restore')
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', true)
    expect(remote.execute).not.toHaveBeenCalled()
    expect(h.actions.setDraft).not.toHaveBeenCalled()
    expect(h.actions.persistDraft).not.toHaveBeenCalled()
    expect(h.actions.submit).not.toHaveBeenCalled()
  })

  it('executes only after confirmation and restores the returned prompt as an unsent persisted draft', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 2, draft: 'restored editable prompt' }
    const remote = remoteWith(async () => preview(), async () => result)
    const h = setup({ remote })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))
    await screen.findByRole('dialog')
    expect(remote.execute).not.toHaveBeenCalled()
    expect(h.actions.setDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('restored editable prompt') })

    const request: CheckpointRollbackRequest = { sessionId, turn: 2 }
    expect(remote.execute).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(h.actions.persistDraft).toHaveBeenCalledTimes(1)
    expect(h.actions.submit).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('cancels an in-flight restore on disable and accepts a fresh compatible preview after re-enable', async () => {
    const executing = deferred<CheckpointRollbackResult>()
    let executeSignal: AbortSignal | undefined
    const remote = remoteWith(async () => preview(), (_request, signal) => {
      executeSignal = signal
      return executing.promise
    })
    const h = setup({ remote })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(remote.execute).toHaveBeenCalledTimes(1) })

    h.setEnabled(false)
    expect(executeSignal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Roll back to here' })).toBeNull()
    executing.resolve({ sessionId, turn: 2, draft: 'late prompt' })
    await Promise.resolve()
    expect(h.actions.setDraft).not.toHaveBeenCalled()

    h.setEnabled(true)
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(remote.preview).toHaveBeenCalledTimes(2)
    expect(remote.execute).toHaveBeenCalledTimes(1)
  })

  it('drops stale preview responses by request version, session, and turn', async () => {
    const first = deferred<CheckpointRollbackPreview>()
    const second = deferred<CheckpointRollbackPreview>()
    const remote = remoteWith(vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise))
    const h = setup({ remote })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))
    h.rollback.close()
    h.rerenderTurn(turnFixture(3, { startSeq: 6 }))
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))

    first.resolve(preview({ messages: [{ seq: 4, type: 'assistant/message', text: 'stale response' }] }))
    await Promise.resolve()
    expect(screen.queryByText('stale response')).toBeNull()
    expect(h.rollback.getSnapshot().active).toMatchObject({ turn: 3, status: 'loading' })

    second.resolve(preview({ sessionId: 'other-session' as SessionId, turn: 3 }))
    await Promise.resolve()
    expect(h.rollback.getSnapshot().active).toMatchObject({ turn: 3, status: 'loading' })
    h.rollback.close()
  })

  it('allows execute to finish and restores the draft when surface replacement unmounts the turn-tail', async () => {
    const executing = deferred<CheckpointRollbackResult>()
    let executeSignal: AbortSignal | undefined
    const remote = remoteWith(async () => preview(), (_request, signal) => {
      executeSignal = signal
      return executing.promise
    })
    const h = setup({ remote })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(remote.execute).toHaveBeenCalledTimes(1) })

    h.unmount()
    expect(executeSignal?.aborted).toBe(false)
    executing.resolve({ sessionId, turn: 2, draft: 'prompt after surface replacement' })
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('prompt after surface replacement') })
    expect(h.actions.persistDraft).toHaveBeenCalledTimes(1)
    expect(h.actions.submit).not.toHaveBeenCalled()
    expect(h.rollback.getSnapshot().active).toBeNull()
  })

  it('aborts preview and removes dialog subscriptions on unmount', async () => {
    const pending = deferred<CheckpointRollbackPreview>()
    let signal: AbortSignal | undefined
    const remote = remoteWith((_request, requestSignal) => {
      signal = requestSignal
      return pending.promise
    })
    const h = setup({ remote })
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to here' }))
    expect(h.rollback.getSnapshot().active).toMatchObject({ status: 'loading' })

    h.unmount()
    expect(signal?.aborted).toBe(true)
    expect(h.rollback.getSnapshot().active).toBeNull()
    pending.resolve(preview())
    await Promise.resolve()
    expect(h.rollback.getSnapshot().active).toBeNull()
  })
})
