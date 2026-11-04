// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installContextMeterEnhance } from '../src/client/context/enhance-meter.ts'
import { installUsageMeterLink } from '../src/client/dsh/usage-meter.ts'
import { installSessionStatsCheckpointLink } from '../src/client/rollback/session-stats-meter.ts'

function mountComposerDock(): HTMLElement {
  const dock = document.createElement('div')
  dock.setAttribute('data-composer-dock', '')
  const trigger = document.createElement('button')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'true')
  dock.append(trigger)
  document.body.append(dock)
  return dock
}

function mountContextPanel(): { panel: HTMLElement, rows: HTMLElement[] } {
  mountComposerDock()
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')
  const dl = document.createElement('dl')
  const rows = ['System', 'Tools', 'Messages'].map(label => {
    const row = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = '~1K'
    row.append(dt, dd)
    dl.append(row)
    return row
  })
  panel.append(dl)
  document.body.append(panel)
  return { panel, rows }
}

function mountTokenUsagePanel(): { panel: HTMLElement, title: HTMLElement } {
  mountComposerDock()
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')

  const title = document.createElement('div')
  const name = document.createElement('span')
  name.textContent = 'Token 用量'
  const total = document.createElement('span')
  total.textContent = '129,793,409 tok'
  title.append(name, total)

  const dl = document.createElement('dl')
  for (const [label, value] of [
    ['缓存命中', '97%'],
    ['未缓存输入', '3,301,235 tok'],
    ['缓存读取', '126,144,000 tok'],
    ['输出', '348,174 tok'],
  ] as const) {
    const row = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    row.append(dt, dd)
    dl.append(row)
  }

  panel.append(title, dl)
  document.body.append(panel)
  return { panel, title }
}

describe('installContextMeterEnhance', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('makes official context rows clickable and leaves Token 用量 alone', () => {
    const { panel, rows } = mountContextPanel()
    const open = vi.fn()
    const dispose = installContextMeterEnhance({
      enabled: () => true,
      sessionId: () => 's1',
      open,
      t: (key, params) => {
        if (key.startsWith('contextInspectCategory_')) return key.slice('contextInspectCategory_'.length)
        if (key === 'contextInspectOpenCategory') return `open ${params?.category}`
        return key
      },
    })

    expect(panel.getAttribute('data-agent-enhancer-context')).toBe('1')
    expect(rows[2]?.getAttribute('data-agent-enhancer-context-row')).toBe('messages')
    rows[2]?.click()
    expect(open).toHaveBeenCalledWith('messages')
    expect(panel.querySelector('[data-agent-enhancer-usage]')).toBeNull()
    dispose()
  })
})

describe('installUsageMeterLink', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('wires the Token 用量 title row to open the bill, not the context panel', () => {
    const { title } = mountTokenUsagePanel()
    const open = vi.fn()
    const dispose = installUsageMeterLink({
      open,
      label: () => 'View bill',
    })

    expect(title.getAttribute('data-agent-enhancer-usage')).toBe('1')
    expect(title.getAttribute('aria-label')).toBe('View bill')
    title.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(open).toHaveBeenCalledOnce()
    dispose()
  })

  it('does not treat the System/Tools/Messages dialog as Token 用量', () => {
    mountContextPanel()
    const open = vi.fn()
    const dispose = installUsageMeterLink({
      open,
      label: () => 'View bill',
    })
    expect(document.querySelector('[data-agent-enhancer-usage]')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    dispose()
  })
})

function mountSessionStatsPanel(): { panel: HTMLElement, title: HTMLElement } {
  mountComposerDock()
  const panel = document.createElement('div')
  panel.setAttribute('role', 'dialog')

  const title = document.createElement('div')
  title.textContent = '会话统计'

  const dl = document.createElement('dl')
  for (const [label, value] of [
    ['模型用时', '27秒'],
    ['工具调用用时', '17秒'],
    ['首 token 平均 (TTFT)', '0.8秒'],
    ['输出速度 (TPS)', '99 tok/s'],
  ] as const) {
    const row = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = value
    row.append(dt, dd)
    dl.append(row)
  }

  panel.append(title, dl)
  document.body.append(panel)
  return { panel, title }
}

describe('installSessionStatsCheckpointLink', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('wires the 会话统计 title to open the checkpoint timeline', () => {
    const { title } = mountSessionStatsPanel()
    const open = vi.fn()
    const dispose = installSessionStatsCheckpointLink({
      enabled: () => true,
      sessionId: () => 's1',
      open,
      label: () => 'Checkpoint timeline',
    })

    expect(title.getAttribute('data-agent-enhancer-checkpoint')).toBe('1')
    expect(title.getAttribute('aria-label')).toBe('Checkpoint timeline')
    title.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(open).toHaveBeenCalledOnce()
    dispose()
  })

  it('ignores Token 用量 and context composition panels', () => {
    mountTokenUsagePanel()
    const open = vi.fn()
    const dispose = installSessionStatsCheckpointLink({
      enabled: () => true,
      sessionId: () => 's1',
      open,
      label: () => 'Checkpoint timeline',
    })
    expect(document.querySelector('[data-agent-enhancer-checkpoint]')).toBeNull()
    dispose()
  })
})
