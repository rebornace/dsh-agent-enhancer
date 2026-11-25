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
}

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
 * Wire the controller to cordis.
 *
 * The event names come from a working 0.2.x implementation:
 * `session/event`, `approval/request`, `user-questions/request`. The two
 * waterline hooks return the decision itself, so the host waits on the phone
 * exactly as it would wait on the desktop.
 *
 * Deliberately conservative: an untracked session, a multi-question card, or a
 * task that already has a pending falls through to `next()` instead of guessing.
 */
export function installRemoteHostBridge(ctx: Context, options: HostBridgeOptions): HostBridge {
  const controller = new RemoteController({
    actions: {
      sendPrompt: (sessionId, text) => options.ports.prompt(sessionId, text, 'queue'),
      setPaused: (sessionId, paused) => options.ports.setPaused(sessionId, paused),
      stop: sessionId => options.ports.cancel(sessionId),
    },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  })

  const known = (sessionId: string): boolean =>
    controller.tasks().some(task => task.id === sessionId)

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
        controller.onTurnStart(sessionId, at)
        break
      case 'turn/end':
        controller.onTurnEnd(sessionId, turnEndKind(data.reason), turnEndError(data.reason), at)
        break
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

  const onApprovalRequest = (request: ApprovalRequestLike, next: () => unknown): unknown => {
    if (!canAnswer()) return next()
    const sessionId = sessionIdOf(request?.agent)
    if (sessionId === undefined || !known(sessionId)) return next()
    try {
      const handle = controller.askApproval(sessionId, {
        prompt: describeApproval(request),
        ...(typeof request.approvalId === 'string' ? { approvalId: request.approvalId } : {}),
        risk: 'other',
      })
      return handle.wait
    } catch {
      // Already waiting on another decision: leave this one to the desktop.
      return next()
    }
  }

  const onQuestionRequest = (request: QuestionRequestLike, next: () => unknown): unknown => {
    if (!canAnswer()) return next()
    const sessionId = sessionIdOf(request?.agent) ?? (typeof request?.sessionId === 'string' ? request.sessionId : undefined)
    if (sessionId === undefined || !known(sessionId)) return next()
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
      return handle.wait.then(text => ({
        answers: [{ id: questionId, ...pickAnswer(labels, text) }],
      }))
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
