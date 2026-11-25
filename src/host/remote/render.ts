import type { ChannelCapabilities, Pending, PresentedState, Task } from './types.ts'

const STATE_LABEL: Record<PresentedState, string> = {
  running: '运行中',
  waiting: '待决定',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  stopped: '已停止',
  offline: '离线',
}

export interface TaskAction {
  readonly id: 'approve' | 'reject' | 'detail'
  readonly label: string
  /** Text command the action is equivalent to; button callbacks send this back. */
  readonly command: string
}

/** Actions for a pending decision. Buttons are a shortcut for the same words. */
export function decisionActions(pending: Pending): readonly TaskAction[] {
  return [
    { id: 'approve', label: '批准', command: `批准 ${pending.code}` },
    { id: 'reject', label: '拒绝', command: `拒绝 ${pending.code}` },
    { id: 'detail', label: '详情', command: '详情' },
  ]
}

function decisionHint(pending: Pending, capabilities: ChannelCapabilities): string {
  if (capabilities.buttons) {
    return `点下方按钮，或回复「批准 ${pending.code}」/「拒绝 ${pending.code}」`
  }
  return `回复「批准 ${pending.code}」或「拒绝 ${pending.code}」`
}

function pendingBody(pending: Pending): string[] {
  const lines = [pending.prompt]
  if (pending.options !== undefined && pending.options.length > 0) {
    const options = pending.options.map((option, index) => `${index + 1}) ${option}`).join('  ')
    lines.push(`选项：${options}`)
  }
  return lines
}

/** One task card in plain text. Buttons are the adapter's job; this is the fallback shape. */
export function renderTaskCard(
  task: Task,
  number: number,
  capabilities: ChannelCapabilities,
  presented: PresentedState = task.state,
): string {
  const head = `【${number}】${task.title} · ${STATE_LABEL[presented]}`
  if (task.pending !== undefined && presented !== 'offline') {
    return [head, ...pendingBody(task.pending), decisionHint(task.pending, capabilities)].join('\n')
  }
  if (presented === 'running' && task.lastLine !== undefined) {
    return [head, `最近：${task.lastLine}`].join('\n')
  }
  return head
}

/** Compact list used by the `任务` word. */
export function renderTaskList(
  tasks: readonly Task[],
  numbers: ReadonlyMap<string, number>,
  capabilities: ChannelCapabilities,
): string {
  if (tasks.length === 0) return '当前没有任务。在电脑上开始一个任务后，这里会出现。'
  const lines = tasks.map(task => {
    const number = numbers.get(task.id) ?? 0
    const marker = task.pending !== undefined ? ' ← 需要你' : ''
    return `${number} ${task.title}  ${STATE_LABEL[task.state]}${marker}`
  })
  const pending = tasks.find(task => task.pending !== undefined)
  const hint = pending === undefined
    ? '回复「切 2」切换任务'
    : capabilities.buttons
      ? '点消息里的按钮处理待办，或回复「切 2」切换任务'
      : '回复「批准 <编号>」处理待办，或回复「切 2」切换任务'
  return [...lines, '', hint].join('\n')
}

/**
 * Split long text for a channel.
 *
 * `maxChars` is a readability budget, not a protocol limit (WeChat accepted
 * 1801 chars in testing). Chunks keep a `(i/n)` marker and prefer newlines.
 */
export function splitForChannel(text: string, maxChars: number): readonly string[] {
  const limit = Math.max(1, Math.floor(maxChars))
  if (text.length <= limit) return [text]
  const bodyLimit = Math.max(1, limit - 12)
  const chunks: string[] = []
  let rest = text
  while (rest.length > bodyLimit) {
    let cut = rest.lastIndexOf('\n', bodyLimit)
    if (cut < Math.floor(bodyLimit / 2)) cut = bodyLimit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '') chunks.push(rest)
  return chunks.map((chunk, index) => `${chunk}\n(${index + 1}/${chunks.length})`)
}
