import { routeAnswer, routeDecision } from './approval-router.ts'
import { parseCommand } from './commands.ts'
import { listActionButtons, renderTaskCard, renderTaskList, taskActionButtons } from './render.ts'
import type { ChannelButton } from './render.ts'
import { TaskBoard } from './task-board.ts'
import type { TurnEndReason } from './task-board.ts'
import { createCode, createPending } from './types.ts'
import type { ChannelCapabilities, Risk, Task, TaskId } from './types.ts'

/** Side effects the host executes on the controller's behalf. */
export interface RemoteActions {
  readonly sendPrompt: (sessionId: TaskId, text: string) => Promise<void>
  readonly setPaused: (sessionId: TaskId, paused: boolean) => Promise<void>
  readonly stop: (sessionId: TaskId) => Promise<void>
}

export interface ApprovalAsk {
  /** Host-side approval identity, when the request exposes one. */
  readonly approvalId?: string
  readonly prompt: string
  readonly risk?: Risk
}

export interface QuestionAsk {
  readonly questionId?: string
  readonly prompt: string
  readonly options?: readonly string[]
}

export interface AskHandle<T> {
  readonly code: string
  readonly wait: Promise<T>
}

export interface Reply {
  readonly text: string
  /** Inline actions for channels with buttons; omitted for text-only channels. */
  readonly buttons?: readonly ChannelButton[]
}

export interface RemoteControllerOptions {
  readonly actions: RemoteActions
  readonly now?: () => number
  readonly ttlMs?: number
  readonly code?: () => string
}

export interface SessionRow {
  readonly id: TaskId
  readonly title: string
  readonly running: boolean
}

/**
 * Orchestrates the task board for remote chats.
 *
 * The host wiring calls `track` / `onTurn*` / `ask*`; a channel adapter calls
 * `execute` with the user's text and sends back the reply. Nothing here knows
 * about WeChat, HTTP, or cordis.
 */
export class RemoteController {
  private readonly board = new TaskBoard()
  private readonly numbers = new Map<TaskId, number>()
  private readonly focusByChat = new Map<string, TaskId>()
  private readonly approvalWaiters = new Map<string, (outcome: 'approve' | 'reject') => void>()
  private readonly questionWaiters = new Map<string, (text: string) => void>()
  private readonly codeByApprovalId = new Map<string, string>()
  private counter = 0

  constructor(private readonly options: RemoteControllerOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private nextCode(): string {
    return this.options.code?.() ?? createCode()
  }

  track(row: SessionRow, at = this.now()): void {
    const existing = this.numbers.get(row.id)
    if (existing === undefined) {
      this.counter += 1
      this.numbers.set(row.id, this.counter)
    }
    this.board.register(row.id, row.title, row.running ? 'running' : 'done', at)
  }

  untrack(id: TaskId): void {
    this.board.remove(id)
    this.numbers.delete(id)
    for (const [chat, focused] of this.focusByChat) {
      if (focused === id) this.focusByChat.delete(chat)
    }
  }

  numberOf(id: TaskId): number | undefined {
    return this.numbers.get(id)
  }

  tasks(): readonly Task[] {
    const list = this.board.list()
    return [...list].sort((left, right) => (this.numbers.get(left.id) ?? 0) - (this.numbers.get(right.id) ?? 0))
  }

  onTurnStart(id: TaskId, at = this.now()): void {
    this.board.turnStart(id, at)
  }

  onTurnEnd(id: TaskId, reason: TurnEndReason, error?: string, at = this.now()): void {
    this.board.turnEnd(id, reason, at, error)
  }

  onTitle(id: TaskId, title: string): void {
    this.board.rename(id, title)
  }

  /** Record the model's final text so `详情` can show the actual answer. */
  onAnswer(id: TaskId, text: string, at = this.now()): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    this.board.answer(id, trimmed.length > 8_000 ? `${trimmed.slice(0, 7_999)}…` : trimmed, at)
  }

  onNote(id: TaskId, line: string, at = this.now()): void {
    this.board.note(id, line, at)
  }

  /** Hold an approval request; resolves with the remote decision, or never if dismissed. */
  askApproval(id: TaskId, ask: ApprovalAsk, at = this.now()): AskHandle<'approve' | 'reject'> {
    const pending = createPending({
      kind: 'approval',
      sessionId: id,
      prompt: ask.prompt,
      ...(ask.risk === undefined ? {} : { risk: ask.risk }),
      code: this.nextCode(),
      ...(this.options.ttlMs === undefined ? {} : { ttlMs: this.options.ttlMs }),
    }, at)
    this.board.ask(id, pending, at)
    if (ask.approvalId !== undefined) this.codeByApprovalId.set(ask.approvalId, pending.code)
    const wait = new Promise<'approve' | 'reject'>(resolve => {
      this.approvalWaiters.set(pending.code, resolve)
    })
    return { code: pending.code, wait }
  }

  askQuestion(id: TaskId, ask: QuestionAsk, at = this.now()): AskHandle<string> {
    const pending = createPending({
      kind: 'question',
      sessionId: id,
      prompt: ask.prompt,
      ...(ask.options === undefined ? {} : { options: ask.options }),
      code: this.nextCode(),
      ...(this.options.ttlMs === undefined ? {} : { ttlMs: this.options.ttlMs }),
    }, at)
    this.board.ask(id, pending, at)
    const wait = new Promise<string>(resolve => {
      this.questionWaiters.set(pending.code, resolve)
    })
    return { code: pending.code, wait }
  }

  /** Another client (e.g. the desktop) resolved this approval: drop the remote card. */
  dismissApproval(approvalId: string, at = this.now()): boolean {
    const code = this.codeByApprovalId.get(approvalId)
    if (code === undefined) return false
    this.codeByApprovalId.delete(approvalId)
    this.approvalWaiters.delete(code)
    const task = this.board.list().find(entry => entry.pending?.code === code)
    if (task !== undefined) {
      // Keep the waiter's promise pending: the host owns that resolution now.
      this.board.clearPending(task.id)
      return true
    }
    return false
  }

  /** Drop expired codes so the board does not keep stale cards. */
  expire(at = this.now()): readonly string[] {
    const dropped = this.board.expire(at)
    for (const code of dropped) {
      this.approvalWaiters.delete(code)
      this.questionWaiters.delete(code)
    }
    return dropped
  }

  /**
   * Resolve every held ask so tearing the channel down cannot leave a tool
   * waiting forever. An approval becomes a rejection (the desktop had already
   * been bypassed by this hook); a question becomes an empty answer.
   */
  releasePending(): void {
    for (const resolve of this.approvalWaiters.values()) resolve('reject')
    this.approvalWaiters.clear()
    for (const resolve of this.questionWaiters.values()) resolve('')
    this.questionWaiters.clear()
    for (const task of this.board.list()) {
      if (task.pending !== undefined) this.board.clearPending(task.id)
    }
  }

  renderCard(id: TaskId, capabilities: ChannelCapabilities, hostOnline = true): string | undefined {
    const task = this.board.get(id)
    if (task === undefined) return undefined
    const number = this.numbers.get(id) ?? 0
    return renderTaskCard(task, number, capabilities, this.board.presented(id, hostOnline) ?? task.state)
  }

  renderList(capabilities: ChannelCapabilities): string {
    return renderTaskList(this.tasks(), this.numbers, capabilities)
  }

  focus(chatId: string): TaskId | undefined {
    return this.focusByChat.get(chatId)
  }

  /** Restore a persisted focus; ignore ids the board no longer has. */
  setFocus(chatId: string, id: TaskId): void {
    if (this.board.get(id) === undefined) return
    this.focusByChat.set(chatId, id)
  }

  /** Handle one inbound message for a chat. Returns the reply text. */
  async execute(chatId: string, input: string, capabilities: ChannelCapabilities, at = this.now()): Promise<Reply> {
    const command = parseCommand(input)
    if (command.kind === 'invalid') return { text: this.invalidText(command.reason) }
    if (command.kind === 'tasks') {
      const text = this.renderList(capabilities)
      if (!capabilities.buttons) return { text }
      const buttons = listActionButtons(this.tasks(), this.numbers)
      return buttons.length === 0 ? { text } : { text, buttons }
    }

    if (command.kind === 'switch') {
      const target = this.byNumber(command.number)
      if (target === undefined) return { text: `没有编号 ${command.number} 的任务。回「任务」看列表。` }
      this.focusByChat.set(chatId, target.id)
      return this.withTaskButtons(`已切到 【${command.number}】${target.title}`, target.id, capabilities)
    }

    if (command.kind === 'detail') {
      const pending = this.tasks().filter(task => task.pending !== undefined)
      const target = command.number === undefined
        ? (pending.length === 1 ? pending[0] : this.taskFor(chatId))
        : this.byNumber(command.number)
      if (target === undefined) return { text: '没有可显示的任务。回「任务」看列表。' }
      // Viewing a task selects it: follow-ups continue what the user is reading.
      this.focusByChat.set(chatId, target.id)
      const card = this.renderCard(target.id, capabilities)
      const answer = this.board.get(target.id)?.lastAnswer
      const text = card === undefined
        ? '任务已不存在。'
        : answer === undefined || answer === ''
          ? card
          : `${card}\n\n回答：${answer}`
      return this.withTaskButtons(text, target.id, capabilities)
    }

    if (command.kind === 'approve' || command.kind === 'reject') {
      return this.decide(command.kind, command.code, at)
    }

    if (command.kind === 'answer') {
      const route = routeAnswer(this.board.list(), command, at)
      if (!route.ok) return { text: this.routeFailureText(route.reason, route.codes) }
      const result = this.board.decide(route.taskId, route.pending.code, at)
      if (result !== 'ok') return { text: this.routeFailureText(result === 'expired' ? 'expired' : 'unknown-code') }
      const waiter = this.questionWaiters.get(route.pending.code)
      this.questionWaiters.delete(route.pending.code)
      waiter?.(route.text)
      return { text: `已回复【${this.numbers.get(route.taskId) ?? 0}】${this.taskTitle(route.taskId)}` }
    }

    if (command.kind === 'pause' || command.kind === 'resume') {
      const target = this.taskFor(chatId)
      if (target === undefined) return { text: '先回「任务」选一个任务。' }
      const paused = command.kind === 'pause'
      try {
        await this.options.actions.setPaused(target.id, paused)
      } catch (error) {
        return { text: `操作失败：${error instanceof Error ? error.message : String(error)}` }
      }
      if (paused) this.board.pause(target.id)
      else this.board.resume(target.id, at)
      const text = paused
        ? `已暂停【${this.numbers.get(target.id) ?? 0}】${target.title}`
        : `已继续【${this.numbers.get(target.id) ?? 0}】${target.title}`
      return this.withTaskButtons(text, target.id, capabilities)
    }

    // Plain text goes to the focused task.
    const target = this.taskFor(chatId)
    if (target === undefined) {
      return { text: this.tasks().length === 0 ? '当前没有任务。' : '先回「任务」选一个任务，再发消息。' }
    }
    try {
      await this.options.actions.sendPrompt(target.id, command.text)
    } catch (error) {
      return { text: `发送失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return this.withTaskButtons(
      `已发给【${this.numbers.get(target.id) ?? 0}】${target.title}`,
      target.id,
      capabilities,
    )
  }

  /** Attach a task's actions when the channel can render buttons. */
  private withTaskButtons(text: string, id: TaskId, capabilities: ChannelCapabilities): Reply {
    if (!capabilities.buttons) return { text }
    const task = this.board.get(id)
    if (task === undefined) return { text }
    const buttons = taskActionButtons(task)
    return buttons.length === 0 ? { text } : { text, buttons }
  }

  private decide(kind: 'approve' | 'reject', code: string | undefined, at: number): Reply {
    const tasks = this.board.list()
    const route = kind === 'approve'
      ? routeDecision(tasks, code === undefined ? { kind: 'approve' } : { kind: 'approve', code }, at)
      : routeDecision(tasks, code === undefined ? { kind: 'reject' } : { kind: 'reject', code }, at)
    if (!route.ok) return { text: this.routeFailureText(route.reason, route.codes) }
    const result = this.board.decide(route.taskId, route.pending.code, at)
    if (result !== 'ok') return { text: this.routeFailureText(result === 'expired' ? 'expired' : 'unknown-code') }
    const waiter = this.approvalWaiters.get(route.pending.code)
    this.approvalWaiters.delete(route.pending.code)
    if (route.pending.kind === 'approval') waiter?.(route.decision)
    const label = route.decision === 'approve' ? '已批准' : '已拒绝'
    return { text: `${label}【${this.numbers.get(route.taskId) ?? 0}】${this.taskTitle(route.taskId)}` }
  }

  private routeFailureText(reason: string, codes?: readonly string[]): string {
    switch (reason) {
      case 'no-pending':
        return '当前没有待处理的决定。'
      case 'ambiguous':
        return `有多个待处理，请带编号：${(codes ?? []).join(' / ')}`
      case 'unknown-code':
        return (codes ?? []).length > 0
          ? `没有这个编号，当前可用：${(codes ?? []).join(' / ')}`
          : '没有这个编号，当前没有待处理。'
      case 'expired':
        return '这条已经过期，等电脑上重新发起。'
      case 'not-a-decision':
      case 'not-an-answer':
        return '这不是一个决定。'
      default:
        return '处理失败。'
    }
  }

  private invalidText(reason: string): string {
    switch (reason) {
      case 'empty':
        return '说点什么，或者回「任务」。'
      case 'bad-code':
        return '编号是 4 位小写字母数字，例如 a3f9。'
      case 'bad-task-number':
        return '任务编号是正整数，例如「切 2」。'
      case 'unexpected-argument':
        return '这个词后面不需要参数。'
      case 'answer-empty':
        return '回答内容不能为空。'
      case 'empty-message':
        return '要发给任务的内容不能为空。'
      default:
        return '没看懂，回「任务」看可选操作。'
    }
  }

  private byNumber(number: number): { id: TaskId; title: string } | undefined {
    for (const task of this.tasks()) {
      if (this.numbers.get(task.id) === number) return { id: task.id, title: task.title }
    }
    return undefined
  }

  private taskFor(chatId: string): { id: TaskId; title: string } | undefined {
    const focused = this.focusByChat.get(chatId)
    if (focused !== undefined) {
      const task = this.board.get(focused)
      if (task !== undefined) return { id: task.id, title: task.title }
      this.focusByChat.delete(chatId)
    }
    // No explicit focus: a single task waiting for the user is the obvious one.
    const waiting = this.tasks().filter(task => task.pending !== undefined)
    if (waiting.length === 1) {
      const only = waiting[0]
      if (only === undefined) return undefined
      this.focusByChat.set(chatId, only.id)
      return { id: only.id, title: only.title }
    }
    const all = this.tasks()
    if (all.length !== 1) return undefined
    const only = all[0]
    if (only === undefined) return undefined
    this.focusByChat.set(chatId, only.id)
    return { id: only.id, title: only.title }
  }

  private taskTitle(id: TaskId): string {
    return this.board.get(id)?.title ?? id
  }
}
