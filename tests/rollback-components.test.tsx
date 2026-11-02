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
import { RollbackModalHost } from '../src/client/rollback/modal-host.tsx'
import { RollbackUserNode } from '../src/client/rollback/user-node.tsx'
import type { RollbackUserNodeProps } from '../src/client/rollback/user-node.tsx'
import { composerLocales } from '../src/client/locales.ts'
import { RollbackController } from '../src/client/rollback/controller.ts'
import type { RollbackRemote } from '../src/client/rollback/controller.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-client-ui-primitives')>()
  return { ...actual, writeClipboard: vi.fn(async () => true) }
})

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
    draft: request.operation === 'undo' ? '' : 'second prompt',
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
  remote?: RollbackRemote
  turn?: TurnLocation
  operation?: 'rollback' | 'undo'
} = {}) {
  let enabled = options.enabled ?? true
  let turn = options.turn ?? turnFixture()
  const operation = options.operation ?? 'rollback'
  const remote = options.remote ?? remoteWith()
  const rollback = controller(remote, () => enabled)
  const actions = {
    setDraft: vi.fn(),
    persistDraft: vi.fn(),
    submit: vi.fn(),
  } as unknown as InputActions
  const tree = () => <RollbackModalHost rollback={rollback} t={translate} inputActions={actions} />
  const view = render(tree())
  return {
    ...view,
    actions,
    rollback,
    remote,
    open() {
      rollback.open(turn.turn, operation)
    },
    setEnabled(value: boolean) {
      enabled = value
      rollback.refreshSettings()
      view.rerender(tree())
    },
    rerenderTurn(nextTurn: TurnLocation) {
      turn = nextTurn
      view.rerender(tree())
    },
  }
}

afterEach(() => {
  cleanup()
  for (const rollback of controllers.splice(0)) rollback.dispose()
})

describe('RollbackModalHost', () => {

  it('previews messages, tracked files, gaps, and conflicts without writing before confirmation', async () => {
    const remote = remoteWith(async () => preview({
      unavailable: ['workspace-capture-failed', 'prompt-non-text-content'],
      conflicts: [{ path: 'src/app.ts', reason: 'hash-mismatch', expectedHash: 'before', actualHash: 'after' }],
    }))
    const h = setup({ remote })
    h.open()

    const dialog = await screen.findByRole('dialog', { name: 'Restore before turn 2' })
    expect(dialog.textContent).toContain('Choose conversation-only restore')
    expect(dialog.textContent).toContain('second prompt')
    expect(dialog.textContent).toContain('second response')
    expect(dialog.textContent).toContain('src/app.ts')
    // Soft capture gaps must not appear under a fatal unavailable heading.
    expect(dialog.textContent).not.toContain('Workspace capture is incomplete')
    expect(dialog.textContent).not.toContain('The original prompt was not plain text')
    expect(dialog.textContent).toContain('Full restore is limited')
    expect(dialog.textContent).toContain('Conversation-only restore is still available')
    expect(dialog.textContent).toContain('File changed after this checkpoint')
    expect(dialog.textContent).not.toContain('complete world restore')
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Restore conversation only' })).toHaveProperty('disabled', false)
    expect(remote.execute).not.toHaveBeenCalled()
    expect(h.actions.setDraft).not.toHaveBeenCalled()
    expect(h.actions.persistDraft).not.toHaveBeenCalled()
    expect(h.actions.submit).not.toHaveBeenCalled()
  })

  it('allows both confirms when soft capture gaps exist but no tracked files need restore', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 2, draft: 'cancelled prompt' }
    const remote = remoteWith(async () => preview({
      files: [],
      unavailable: ['incomplete-checkpoint', 'workspace-capture-failed', 'prompt-non-text-content'],
    }), async () => result)
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Restore conversation only' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('cancelled prompt') })
    expect(remote.execute).toHaveBeenCalledWith({
      sessionId,
      turn: 2,
      operation: 'rollback',
      scope: 'conversation-and-files',
    }, expect.any(AbortSignal))
  })

  it('allows conversation confirm when the only hard-looking gap is compacted-surface', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 2, draft: 'compacted draft' }
    const remote = remoteWith(async () => preview({
      files: [{ path: 'src/app.ts', change: 'modify' }],
      unavailable: ['compacted-surface'],
    }), async () => result)
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Restore conversation only' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation only' }))
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('compacted draft') })
  })

  it('keeps conversation confirm enabled for permission soft gaps but blocks missing surfaces', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 2, draft: 'soft draft' }
    const soft = setup({
      remote: remoteWith(async () => preview({
        files: [{ path: 'src/app.ts', change: 'modify' }],
        unavailable: ['permission-denied'],
      }), async () => result),
    })
    soft.open()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Restore conversation only' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation only' }))
    await waitFor(() => { expect(soft.actions.setDraft).toHaveBeenCalledWith('soft draft') })
    soft.unmount()

    const blocked = setup({
      remote: remoteWith(async () => preview({
        messages: [],
        files: [],
        unavailable: ['unknown-surface'],
      })),
    })
    blocked.open()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Restore conversation only' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', true)
  })

  it('keeps confirms enabled for a cancelled first turn with soft gaps and empty files', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 1, draft: 'first cancelled prompt' }
    const remote = remoteWith(async () => preview({
      turn: 1,
      files: [],
      unavailable: ['incomplete-checkpoint', 'workspace-capture-failed'],
    }), async () => result)
    const h = setup({ remote, turn: turnFixture(1, { startSeq: 1 }) })
    h.open()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Restore conversation only' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation only' }))
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('first cancelled prompt') })
    expect(remote.execute).toHaveBeenCalledWith({
      sessionId,
      turn: 1,
      operation: 'rollback',
      scope: 'conversation',
    }, expect.any(AbortSignal))
  })

  it('allows conversation-only restore when only file conflicts block full restore', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 2, draft: 'conversation draft' }
    const remote = remoteWith(async () => preview({
      conflicts: [{ path: 'src/app.ts', reason: 'hash-mismatch', expectedHash: 'before', actualHash: 'after' }],
    }), async () => result)
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Restore conversation and tracked files' })).toHaveProperty('disabled', true)
    const conversationOnly = screen.getByRole('button', { name: 'Restore conversation only' })
    expect(conversationOnly).toHaveProperty('disabled', false)
    fireEvent.click(conversationOnly)
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('conversation draft') })
    expect(remote.execute).toHaveBeenCalledWith({
      sessionId,
      turn: 2,
      operation: 'rollback',
      scope: 'conversation',
    }, expect.any(AbortSignal))
  })

  it('executes only after confirmation and restores the returned prompt as an unsent persisted draft', async () => {
    const result: CheckpointRollbackResult = { sessionId, turn: 2, draft: 'restored editable prompt' }
    const remote = remoteWith(async () => preview(), async () => result)
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    expect(remote.execute).not.toHaveBeenCalled()
    expect(h.actions.setDraft).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('restored editable prompt') })

    const request: CheckpointRollbackRequest = {
      sessionId,
      turn: 2,
      operation: 'rollback',
      scope: 'conversation-and-files',
    }
    expect(remote.execute).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(h.actions.persistDraft).toHaveBeenCalledTimes(1)
    expect(h.actions.submit).not.toHaveBeenCalled()
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('previews and executes undo with distinct copy and clears the draft from the host result', async () => {
    const remote = remoteWith(
      async request => preview({ ...preview(), operation: request.operation, scope: 'conversation-and-files' }),
      async request => ({ sessionId, turn: request.turn, draft: '' }),
    )
    const h = setup({ remote, operation: 'undo' })
    h.open()
    const dialog = await screen.findByRole('dialog', { name: 'Undo restore before turn 2' })
    expect(dialog.textContent).toContain('Withdraw the restore marker')
    fireEvent.click(screen.getByRole('button', { name: 'Undo restore and bring back preview' }))
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('') })
    expect(remote.preview).toHaveBeenCalledWith({ sessionId, turn: 2, operation: 'undo' }, expect.any(AbortSignal))
    expect(remote.execute).toHaveBeenCalledWith({
      sessionId,
      turn: 2,
      operation: 'undo',
      scope: 'conversation-and-files',
    }, expect.any(AbortSignal))
  })

  it('undoes a conversation-only rollback without requiring file restore', async () => {
    const remote = remoteWith(
      async request => preview({
        ...preview(),
        operation: request.operation,
        scope: 'conversation',
        conflicts: [{ path: 'src/app.ts', reason: 'hash-mismatch', expectedHash: 'after', actualHash: 'changed' }],
      }),
      async request => ({ sessionId, turn: request.turn, draft: '' }),
    )
    const h = setup({ remote, operation: 'undo' })
    h.open()
    const dialog = await screen.findByRole('dialog', { name: 'Undo restore before turn 2' })
    expect(dialog.textContent).toContain('Tracked files stay as they are')
    const confirm = screen.getByRole('button', { name: 'Undo restore and bring back conversation' })
    expect(confirm).toHaveProperty('disabled', false)
    fireEvent.click(confirm)
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('') })
    expect(remote.execute).toHaveBeenCalledWith({
      sessionId,
      turn: 2,
      operation: 'undo',
      scope: 'conversation',
    }, expect.any(AbortSignal))
  })

  it('cancels an in-flight restore on disable and accepts a fresh compatible preview after re-enable', async () => {
    const executing = deferred<CheckpointRollbackResult>()
    let executeSignal: AbortSignal | undefined
    const remote = remoteWith(async () => preview(), (_request, signal) => {
      executeSignal = signal
      return executing.promise
    })
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(remote.execute).toHaveBeenCalledTimes(1) })

    h.setEnabled(false)
    expect(executeSignal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    executing.resolve({ sessionId, turn: 2, draft: 'late prompt' })
    await Promise.resolve()
    expect(h.actions.setDraft).not.toHaveBeenCalled()

    h.setEnabled(true)
    h.open()
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
    h.open()
    h.rollback.close()
    h.rerenderTurn(turnFixture(3, { startSeq: 6 }))
    h.open()

    first.resolve(preview({ messages: [{ seq: 4, type: 'assistant/message', text: 'stale response' }] }))
    await Promise.resolve()
    expect(screen.queryByText('stale response')).toBeNull()
    expect(h.rollback.getSnapshot().active).toMatchObject({ turn: 3, status: 'loading' })

    second.resolve(preview({ sessionId: 'other-session' as SessionId, turn: 3 }))
    await Promise.resolve()
    expect(h.rollback.getSnapshot().active).toMatchObject({ turn: 3, status: 'loading' })
    h.rollback.close()
  })

  it('cancels an in-flight preview on disable before confirmation', async () => {
    const pending = deferred<CheckpointRollbackPreview>()
    let previewSignal: AbortSignal | undefined
    const remote = remoteWith((_request, signal) => {
      previewSignal = signal
      return pending.promise
    })
    const h = setup({ remote })
    h.open()
    expect(h.rollback.getSnapshot().active).toMatchObject({ status: 'loading' })

    h.setEnabled(false)
    expect(previewSignal?.aborted).toBe(true)
    expect(screen.queryByRole('dialog')).toBeNull()
    pending.resolve(preview())
    await Promise.resolve()
    expect(h.rollback.getSnapshot().active).toBeNull()
  })

  it('keeps the dialog mounted and finishes draft restore after the message entry unmounts', async () => {
    const executing = deferred<CheckpointRollbackResult>()
    let executeSignal: AbortSignal | undefined
    const remote = remoteWith(async () => preview(), (_request, signal) => {
      executeSignal = signal
      return executing.promise
    })
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(remote.execute).toHaveBeenCalledTimes(1) })

    // Message-row UI can unmount during surface replace; the overlay modal must survive.
    expect(executeSignal?.aborted).toBe(false)
    expect(screen.getByRole('dialog')).toBeTruthy()
    executing.resolve({ sessionId, turn: 2, draft: 'prompt after surface replacement' })
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('prompt after surface replacement') })
    expect(h.actions.persistDraft).toHaveBeenCalledTimes(1)
    expect(h.actions.submit).not.toHaveBeenCalled()
    expect(h.rollback.getSnapshot().active).toBeNull()
  })

  it('ignores mask clicks so restore confirmation is not dismissed accidentally', async () => {
    const h = setup()
    h.open()
    const dialog = await screen.findByRole('dialog')
    const mask = dialog.parentElement?.querySelector('[aria-hidden="true"]')
    expect(mask).toBeTruthy()
    fireEvent.click(mask!)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(h.rollback.getSnapshot().active).toMatchObject({ status: 'ready' })
  })

  it('does not abort an in-flight execute when close is requested', async () => {
    const executing = deferred<CheckpointRollbackResult>()
    let executeSignal: AbortSignal | undefined
    const remote = remoteWith(async () => preview(), (_request, signal) => {
      executeSignal = signal
      return executing.promise
    })
    const h = setup({ remote })
    h.open()
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Restore conversation and tracked files' }))
    await waitFor(() => { expect(remote.execute).toHaveBeenCalledTimes(1) })
    h.rollback.close()
    expect(executeSignal?.aborted).toBe(false)
    expect(h.rollback.getSnapshot().active).toMatchObject({ status: 'executing' })
    executing.resolve({ sessionId, turn: 2, draft: 'kept draft' })
    await waitFor(() => { expect(h.actions.setDraft).toHaveBeenCalledWith('kept draft') })
  })
})

function userNodeView(options: {
  marker?: boolean
  nodeKey?: string
  chatOrder?: string[]
  turn?: TurnLocation
  enabled?: boolean
} = {}) {
  const remote = remoteWith()
  const rollback = controller(remote, () => options.enabled ?? true)
  const turn = options.turn ?? turnFixture()
  const nodeKey = options.nodeKey ?? 'user-node-2'
  const chatOrder = options.chatOrder ?? [nodeKey]
  return {
    view: render(<RollbackUserNode {...{
      sessionId,
      rollback,
      node: {
        key: nodeKey,
        location: { kind: 'turn', turn },
        data: {
          content: [{ type: 'text', text: 'hello' }],
          source: options.marker ? { kind: 'checkpoint-rollback', form: 'notice', summary: 'Rolled back' } : { kind: 'user' },
          ...(options.marker ? { id: 'dsh-composer-enhancer:rollback:2:journal-1' } : {}),
        },
      },
      renderFactorySlot: vi.fn(() => null),
      loadImage: vi.fn(),
      tEnhancer: translate,
      tChat: (key: string) => key,
      useChat: (selector: (state: { order: readonly string[] }) => unknown) => selector({ order: chatOrder }),
      useSession: (selector: (state: { running: boolean }) => unknown) => selector({ running: false }),
      useAccess: () => true,
      inputActions: { setDraft: vi.fn(), persistDraft: vi.fn() },
    } as unknown as RollbackUserNodeProps} />),
    rollback,
  }
}

describe('RollbackUserNode', () => {
  it('keeps the restore icon on ordinary turns and does not put undo on marker rows', async () => {
    const ordinary = userNodeView()
    const actions = {
      setDraft: vi.fn(),
      persistDraft: vi.fn(),
      submit: vi.fn(),
    } as unknown as InputActions
    render(<RollbackModalHost rollback={ordinary.rollback} t={translate} inputActions={actions} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore to here' }))
    expect(await screen.findByRole('dialog', { name: 'Restore before turn 2' })).toBeTruthy()
    ordinary.view.unmount()

    const markerTip = userNodeView({
      marker: true,
      nodeKey: 'marker-tip',
      chatOrder: ['marker-tip'],
    })
    expect(screen.queryByRole('button', { name: 'Restore to here' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo restore' })).toBeNull()
    markerTip.view.unmount()
  })
})
