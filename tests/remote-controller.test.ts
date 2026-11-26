import { describe, expect, it, vi } from 'vitest'
import { RemoteController } from '../src/host/remote/controller.ts'
import type { ChannelCapabilities } from '../src/host/remote/types.ts'

const textOnly: ChannelCapabilities = {
  buttons: false,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 1800,
  privateOnly: true,
}

function setup(codes: readonly string[] = ['a3f9', 'k2m7', 'q7t2']) {
  const queue = [...codes]
  const clock = { now: 0 }
  const actions = {
    sendPrompt: vi.fn(async () => {}),
    setPaused: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  }
  const controller = new RemoteController({
    actions,
    now: () => clock.now,
    code: () => queue.shift() ?? 'zzzz',
  })
  return { controller, actions, clock }
}

function seed(controller: RemoteController) {
  controller.track({ id: 's1', title: '周报导出', running: true }, 0)
  controller.track({ id: 's2', title: '网页重构', running: false }, 0)
}

describe('RemoteController', () => {
  it('numbers tasks on first sight and lists them', () => {
    const { controller } = setup()
    seed(controller)
    expect(controller.numberOf('s1')).toBe(1)
    expect(controller.numberOf('s2')).toBe(2)
    expect(controller.renderList(textOnly)).toContain('1 周报导出')
    expect(controller.renderList(textOnly)).toContain('2 网页重构')
  })

  it('holds an approval and resolves it by code', async () => {
    const { controller } = setup()
    seed(controller)
    const handle = controller.askApproval('s1', { prompt: '写入 report.xlsx', risk: 'write' })
    expect(controller.renderCard('s1', textOnly)).toContain('a3f9')

    const decision = handle.wait
    const reply = await controller.execute('chat-1', '批准 a3f9', textOnly)
    await expect(decision).resolves.toBe('approve')
    expect(reply.text).toContain('已批准')
    expect(controller.renderCard('s1', textOnly)).not.toContain('a3f9')
  })

  it('focuses a lone waiting task when the chat has chosen nothing', async () => {
    const { controller } = setup()
    seed(controller)
    controller.askApproval('s2', { prompt: '写入 report.xlsx' })

    const reply = await controller.execute('chat-1', '先看下这个', textOnly)
    expect(reply.text).toContain('网页重构')
    expect(controller.focus('chat-1')).toBe('s2')
  })

  it('never steals a focus the chat chose explicitly', async () => {
    const { controller } = setup()
    seed(controller)
    await controller.execute('chat-1', '切 1', textOnly)
    controller.askApproval('s2', { prompt: '写入 report.xlsx' })

    const reply = await controller.execute('chat-1', '再改一下', textOnly)
    expect(reply.text).toContain('周报导出')
    expect(controller.focus('chat-1')).toBe('s1')
  })

  it('restores a focus only when the task still exists', () => {
    const { controller } = setup()
    seed(controller)
    controller.setFocus('chat-1', 's2')
    expect(controller.focus('chat-1')).toBe('s2')
    controller.setFocus('chat-2', 'gone')
    expect(controller.focus('chat-2')).toBeUndefined()
  })

  it('releases held asks when the channel is torn down', async () => {
    const { controller } = setup()
    seed(controller)
    const approval = controller.askApproval('s1', { prompt: '写入 report.xlsx' })
    const question = controller.askQuestion('s2', { prompt: '用哪个模板？' })

    controller.releasePending()

    await expect(approval.wait).resolves.toBe('reject')
    await expect(question.wait).resolves.toBe('')
    // A second release is harmless and a late decision finds nothing to answer.
    controller.releasePending()
    expect((await controller.execute('chat-1', '批准 a3f9', textOnly)).text).toContain('没有')
  })

  it('refuses to guess between two approvals and resolves the coded one', async () => {
    const { controller } = setup()
    seed(controller)
    const first = controller.askApproval('s1', { prompt: '写文件' })
    const second = controller.askApproval('s2', { prompt: '跑测试' })

    const ambiguous = await controller.execute('chat-1', '批准', textOnly)
    expect(ambiguous.text).toContain('多个待处理')
    expect(ambiguous.text).toContain('a3f9')
    expect(ambiguous.text).toContain('k2m7')

    const reply = await controller.execute('chat-1', '拒绝 k2m7', textOnly)
    await expect(second.wait).resolves.toBe('reject')
    expect(reply.text).toContain('已拒绝')
    expect(controller.tasks().find(task => task.id === 's1')?.pending?.code).toBe('a3f9')
    void first
  })

  it('answers a question with or without a code', async () => {
    const { controller } = setup()
    seed(controller)
    const handle = controller.askQuestion('s1', { prompt: '选哪个模板？', options: ['简洁', '详细'] })
    await controller.execute('chat-1', `回答 ${handle.code} 详细`, textOnly)
    await expect(handle.wait).resolves.toBe('详细')
  })

  it('routes a plain message to the single focused task and explains when unsure', async () => {
    const { controller, actions } = setup()
    seed(controller)

    const ambiguous = await controller.execute('chat-1', '帮我改一下', textOnly)
    expect(ambiguous.text).toContain('先回「任务」')

    await controller.execute('chat-1', '切 2', textOnly)
    const reply = await controller.execute('chat-1', '帮我改一下', textOnly)
    expect(reply.text).toContain('已发给【2】网页重构')
    expect(actions.sendPrompt).toHaveBeenCalledWith('s2', '帮我改一下')
  })

  it('pauses and resumes the focused task through the host actions', async () => {
    const { controller, actions } = setup()
    seed(controller)
    controller.track({ id: 's1', title: '周报导出', running: true }, 0)
    await controller.execute('chat-1', '切 1', textOnly)

    await controller.execute('chat-1', '暂停', textOnly)
    expect(actions.setPaused).toHaveBeenCalledWith('s1', true)
    expect(controller.tasks().find(task => task.id === 's1')?.state).toBe('paused')

    await controller.execute('chat-1', '继续', textOnly)
    expect(actions.setPaused).toHaveBeenCalledWith('s1', false)
    expect(controller.tasks().find(task => task.id === 's1')?.state).toBe('running')
  })

  it('drops a card when another client resolves the approval', () => {
    const { controller } = setup()
    seed(controller)
    controller.askApproval('s1', { prompt: '写文件', approvalId: 'ap-1' })
    expect(controller.renderCard('s1', textOnly)).toContain('a3f9')

    expect(controller.dismissApproval('ap-1')).toBe(true)
    expect(controller.renderCard('s1', textOnly)).not.toContain('a3f9')
    expect(controller.tasks().find(task => task.id === 's1')?.state).toBe('running')
  })

  it('reports expired codes instead of deciding them', async () => {
    const { controller, clock } = setup()
    seed(controller)
    controller.askApproval('s1', { prompt: '写文件' })
    clock.now = 300_000

    const reply = await controller.execute('chat-1', '批准 a3f9', textOnly)
    expect(reply.text).toContain('过期')
    expect(controller.tasks().find(task => task.id === 's1')?.state).toBe('waiting')
  })

  it('answers malformed input with a concrete hint', async () => {
    const { controller } = setup()
    const reply = await controller.execute('chat-1', '批准 abc', textOnly)
    expect(reply.text).toContain('4 位')
  })
})
