import type { Context } from '@deepseek-ai/cordis'
import { RemoteController } from './controller.ts'
import type { SessionRow } from './controller.ts'
import type { ChannelCapabilities } from './types.ts'

/** Session data as it arrives on `session/event`. */
interface HostSession {
  readonly id?: string
}

interface HostSessionEvent {
  readonly type?: string
  readonly time?: number
  readonly data?: Record<string, unknown>
}

interface HostAgent {
  readonly session?: HostSession
}

interface ApprovalRequestLike {
  readonly agent?: HostAgent
  readonly approvalId?: string
  readonly toolName?: string
  readonly callId?: string
  readonly reason?: string
}

interface HostQuestion {
  readonly id?: string
  readonly header?: string
  readonly detail?: string
  readonly options?: readonly { readonly label?: string }[]
}

interface QuestionRequestLike {
  readonly agent?: HostAgent
  readonly sessionId?: string
  readonly questions?: readonly HostQuestion[]
}

interface LooseContext {
  on(name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean; global?: boolean }): () => void
}

/** Host effects the bridge cannot perform itself. */
export interface HostBridgePorts {
  listSessions(): Promise<readonly SessionRow[]>
  prompt(sessionId: string, text: string, mode: 'queue' | 'steer'): Promise<void>
  cancel(sessionId: string): Promise<void>
  setPaused(sessionId: string, paused: boolean): Promise<void>
  /** Read the last assistant text from history for `详情` on old turns. */
  readAnswer?(sessionId: string): Promise<string | undefined>
  /** Push one notice to the paired chats; failures belong to the channel. */
  notify?(notice: BridgeNotice): void
}

/**
 * A moment the user may care about. The bridge decides *when*; the channel
 * decides how to phrase and where to send it.
 */
export type BridgeNotice =
  | { readonly kind: 'approval' | 'question'; readonly sessionId: string; readonly code: string }
  | { readonly kind: 'decided'; readonly sessionId: string; readonly decision: 'approve' | 'reject' | 'answered'; readonly chatId?: string }
  | { readonly kind: 'failed'; readonly sessionId: string; readonly error?: string }
  | { readonly kind: 'done'; readonly sessionId: string; readonly answer?: string }

export interface HostBridgeOptions {
  readonly ports: HostBridgePorts
  readonly capabilities: ChannelCapabilities
  readonly now?: () => number
  readonly ttlMs?: number
  /**
   * Whether a remote chat can actually answer right now. Without it a parsed
   * chat holds every approval forever even though nothing is listening.
   */
  readonly shouldHold?: () => boolean
}

export interface HostBridge {
  readonly controller: RemoteController
  /** Re-read sessions and register them on the board; returns the row count. */
  refreshSessions(): Promise<number>
  dispose(): void
}

function sessionIdOf(agent: HostAgent | undefined): string | undefined {
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

function turnEndKind(reason: unknown): 'ok' | 'error' | 'aborted' | 'stopped' {
  const kind = reason !== null && typeof reason === 'object' && 'kind' in reason
    ? String((reason as { kind?: unknown }).kind)
    : ''
  switch (kind) {
    case 'completed':
      return 'ok'
    case 'aborted':
    case 'interrupted':
      return 'aborted'
    case 'blocked':
    case 'forked':
      return 'stopped'
    default:
      return 'error'
  }
}

function turnEndError(reason: unknown): string | undefined {
  if (reason === null || typeof reason !== 'object') return undefined
  const error = (reason as { error?: { message?: unknown } }).error
  return typeof error?.message === 'string' ? error.message : undefined
}

function describeApproval(request: ApprovalRequestLike): string {
  const tool = typeof request.toolName === 'string' && request.toolName !== '' ? request.toolName : '工具'
  return typeof request.reason === 'string' && request.reason !== ''
    ? `${tool} 请求执行：${request.reason}`
    : `${tool} 请求执行`
}

/** Text blocks of one assistant message, in order. */
export function assistantText(data: Record<string, unknown>): string | undefined {
  const message = data.message
  if (message === null || typeof message !== 'object') return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as { type?: unknown; text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string' && record.text.trim() !== '') {
      parts.push(record.text.trim())
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

function questionLabels(question: HostQuestion): string[] {
  if (!Array.isArray(question.options)) return []
  return question.options
    .map(option => (typeof option?.label === 'string' ? option.label : ''))
    .filter(label => label !== '')
}

function pickAnswer(labels: readonly string[], text: string): { selected: string[]; custom?: string } {
  const match = labels.find(label => label.trim() === text.trim())
  return match === undefined ? { selected: [], custom: text } : { selected: [match] }
}

/**
 * Invoke the official handler so the desktop card still appears. It returns a
 * promise only when a real desktop surface is waiting; a synchronous value (or
 * a throw) means there is nothing to race with, so the remote ask owns the
 * decision as before.
 */
function callNext(next: () => unknown): Promise<unknown> | undefined {
  let result: unknown
  try {
    result = next()
  } catch {
    return undefined
  }
  if (result === null || typeof result !== 'object') return undefined
  const then = (result as { then?: unknown }).then
  return typeof then === 'function' ? result as Promise<unknown> : undefined
}

/**
 * Wire the controller to cordis.
 *
 * The event names come from a working 0.2.x implementation:
 * `session/event`, `approval/request`, `user-questions/request`. The two
 * waterline hooks offer the ask on **both** surfaces and return the first
 * decision that arrives, so sitting at the desktop never requires signing out
 * of remote control to approve something.
 *
 * Deliberately conservative: an untracked session, a multi-question card, or a
 * task that already has a pending falls through to `next()` instead of guessing.
 */
export function installRemoteHostBridge(ctx: Context, options: HostBridgeOptions): HostBridge {
  const notify = (notice: BridgeNotice): void => {
    try {
      options.ports.notify?.(notice)
    } catch {
      // A channel that cannot push must not break the watermark.
    }
  }
  const controller = new RemoteController({
    actions: {
      sendPrompt: (sessionId, text) => options.ports.prompt(sessionId, text, 'queue'),
      setPaused: (sessionId, paused) => options.ports.setPaused(sessionId, paused),
      stop: sessionId => options.ports.cancel(sessionId),
    },
    onDecision: info => notify({
      kind: 'decided',
      sessionId: info.sessionId,
      decision: info.decision,
      chatId: info.chatId,
    }),
    ...(options.ports.readAnswer === undefined ? {} : { readAnswer: options.ports.readAnswer }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  })

  const known = (sessionId: string): boolean =>
    controller.tasks().some(task => task.id === sessionId)

  const lastAssistant = new Map<string, string>()

  let refreshing: Promise<number> | undefined
  let lastEventRefresh = 0
  const refreshSessions = async (): Promise<number> => {
    if (refreshing !== undefined) return refreshing
    refreshing = (async () => {
      const rows = await options.ports.listSessions()
      for (const row of rows) controller.track(row)
      return rows.length
    })()
    try {
      return await refreshing
    } finally {
      refreshing = undefined
    }
  }

  /**
   * A session this bridge has never seen means the board was built before that
   * session existed (host indexes warm up after plugin apply). Refresh, but not
   * once per event: a busy turn can emit many.
   */
  const refreshForUnknown = (at: number): void => {
    if (at - lastEventRefresh < 2_000) return
    lastEventRefresh = at
    void refreshSessions().catch(() => {})
  }

  const onSessionEvent = (session: HostSession, event: HostSessionEvent): void => {
    const sessionId = typeof session?.id === 'string' ? session.id : undefined
    if (sessionId === undefined || sessionId === '') return
    const data = event?.data ?? {}
    const at = typeof event.time === 'number' ? event.time : (options.now?.() ?? Date.now())
    if (!known(sessionId)) refreshForUnknown(at)
    switch (event.type) {
      case 'turn/start':
        lastAssistant.delete(sessionId)
        controller.onTurnStart(sessionId, at)
        break
      case 'turn/end': {
        const reason = turnEndKind(data.reason)
        controller.onTurnEnd(sessionId, reason, turnEndError(data.reason), at)
        if (!known(sessionId)) break
        if (reason === 'error') {
          notify({ kind: 'failed', sessionId, ...(turnEndError(data.reason) === undefined ? {} : { error: turnEndError(data.reason) }) })
          break
        }
        if (reason === 'ok') {
          const answer = lastAssistant.get(sessionId)
          lastAssistant.delete(sessionId)
          if (answer !== undefined) {
            notify({ kind: 'done', sessionId, answer })
          } else if (options.ports.readAnswer !== undefined) {
            // Live text can be missed (event timing); history still has it.
            void options.ports.readAnswer(sessionId)
              .then(text => notify({
                kind: 'done',
                sessionId,
                ...(text === undefined || text.trim() === '' ? {} : { answer: text }),
              }))
              .catch(() => { notify({ kind: 'done', sessionId }) })
          } else {
            notify({ kind: 'done', sessionId })
          }
        }
        break
      }
      case 'assistant/message': {
        const text = assistantText(data)
        if (text !== undefined) {
          const stored = text.length > 8_000 ? `${text.slice(0, 7_999)}…` : text
          lastAssistant.set(sessionId, stored)
          controller.onAnswer(sessionId, stored, at)
        }
        break
      }
      case 'session/title':
        if (typeof data.title === 'string' && data.title !== '') controller.onTitle(sessionId, data.title)
        break
      case 'tool/result':
        controller.onNote(sessionId, data.error === undefined ? '工具执行完成' : '工具执行失败', at)
        break
      case 'approval/decided':
        if (typeof data.id === 'string') controller.dismissApproval(data.id, at)
        break
    }
  }

  const canAnswer = (): boolean => options.shouldHold?.() !== false

  const onApprovalRequest = async (request: ApprovalRequestLike, next: () => unknown): Promise<unknown> => {
    if (!canAnswer()) return next()
    const sessionId = sessionIdOf(request?.agent)
    if (sessionId === undefined) return next()
    // A brand-new session can ask for approval before the host index lists it.
    if (!known(sessionId)) {
      await refreshSessions().catch(() => 0)
      if (!known(sessionId)) return next()
    }
    try {
      const handle = controller.askApproval(sessionId, {
        prompt: describeApproval(request),
        ...(typeof request.approvalId === 'string' ? { approvalId: request.approvalId } : {}),
        risk: 'other',
      })
      notify({ kind: 'approval', sessionId, code: handle.code })
      // The official answerer speaks in outcomes, not in chat words. Returning
      // `approve` here would be normalized to `unavailable` and leave the
      // desktop card looking unanswered.
      const remote = handle.wait.then(decision => decision === 'approve' ? 'allowed-once' : 'rejected')
      const desktop = callNext(next)
      if (desktop === undefined) return remote
      return Promise.race([
        remote,
        Promise.resolve(desktop).then(outcome => {
          controller.dropPending(handle.code)
          const decision = outcome === 'allowed-once' || outcome === 'approve'
            ? 'approve'
            : outcome === 'rejected' || outcome === 'reject'
              ? 'reject'
              : undefined
          if (decision !== undefined) notify({ kind: 'decided', sessionId, decision })
          return outcome
        }),
      ])
    } catch {
      // Already waiting on another decision: leave this one to the desktop.
      return next()
    }
  }

  const onQuestionRequest = async (request: QuestionRequestLike, next: () => unknown): Promise<unknown> => {
    if (!canAnswer()) return next()
    const sessionId = sessionIdOf(request?.agent) ?? (typeof request?.sessionId === 'string' ? request.sessionId : undefined)
    if (sessionId === undefined) return next()
    if (!known(sessionId)) {
      await refreshSessions().catch(() => 0)
      if (!known(sessionId)) return next()
    }
    const questions = Array.isArray(request.questions) ? request.questions : []
    // One card per message is all the remote UX can answer honestly.
    if (questions.length !== 1) return next()
    const question = questions[0]
    if (question === undefined) return next()
    const questionId = typeof question.id === 'string' ? question.id : undefined
    if (questionId === undefined) return next()
    const labels = questionLabels(question)
    const prompt = typeof question.header === 'string' && question.header !== ''
      ? question.header
      : (typeof question.detail === 'string' && question.detail !== '' ? question.detail : '需要你回答')
    try {
      const handle = controller.askQuestion(sessionId, {
        prompt,
        ...(labels.length === 0 ? {} : { options: labels }),
      })
      notify({ kind: 'question', sessionId, code: handle.code })
      const remote = handle.wait.then(text => ({
        answers: [{ id: questionId, ...pickAnswer(labels, text) }],
      }))
      const desktop = callNext(next)
      if (desktop === undefined) return remote
      return Promise.race([
        remote,
        Promise.resolve(desktop).then(answer => {
          controller.dropPending(handle.code)
          notify({ kind: 'decided', sessionId, decision: 'answered' })
          return answer
        }),
      ])
    } catch {
      return next()
    }
  }

  const loose = ctx as unknown as LooseContext
  const disposers = [
    loose.on('session/event', onSessionEvent as (...args: never[]) => unknown, { global: true }),
    loose.on('approval/request', onApprovalRequest as (...args: never[]) => unknown, { prepend: true, global: true }),
    loose.on('user-questions/request', onQuestionRequest as (...args: never[]) => unknown, { prepend: true, global: true }),
  ]

  return {
    controller,
    refreshSessions,
    dispose() {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // unloading must not throw
        }
      }
    },
  }
}
