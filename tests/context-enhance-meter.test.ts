// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installContextMeterEnhance } from '../src/client/context/enhance-meter.ts'

function mountOfficialPanel(): { dock: HTMLElement, panel: HTMLElement, rows: HTMLElement[] } {
  const dock = document.createElement('div')
  dock.setAttribute('data-composer-dock', '')
  const trigger = document.createElement('button')
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'true')
  dock.append(trigger)
  document.body.append(dock)

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
  return { dock, panel, rows }
}

describe('installContextMeterEnhance', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('makes official rows clickable and opens the rightbar via open()', () => {
    const { panel, rows } = mountOfficialPanel()
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
    expect(document.querySelector('[aria-label="contextInspectDetailTitle"]')).toBeNull()
    dispose()
  })
})
