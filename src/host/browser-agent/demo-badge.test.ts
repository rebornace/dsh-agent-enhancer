/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEMO_RECORDER_SOURCE, DEMO_STOP_SOURCE } from './demo.ts'

const runRecorder = (): unknown => new Function(DEMO_RECORDER_SOURCE)()
const runStop = (): unknown => new Function(`return ${DEMO_STOP_SOURCE}`)()

const badge = (): Element | null => document.querySelector('[data-dsh-demo-badge]')

describe('demonstration badge', () => {
  beforeEach(() => {
    runStop()
    document.body.innerHTML = ''
  })

  it('shows a marker while recording and removes it on stop', () => {
    runRecorder()
    expect(badge()).not.toBeNull()
    runStop()
    expect(badge()).toBeNull()
  })

  it('replaces the marker when the recorder is re-injected after a navigation', () => {
    runRecorder()
    runRecorder()
    expect(document.querySelectorAll('[data-dsh-demo-badge]')).toHaveLength(1)
  })

  it('never intercepts clicks and stays out of the accessibility tree', () => {
    runRecorder()
    const host = badge() as HTMLElement
    expect(host.style.pointerEvents).toBe('none')
    expect(host.getAttribute('aria-hidden')).toBe('true')
    expect(host.style.position).toBe('fixed')
  })

  it('speaks the page language', () => {
    Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'zh-CN' })
    runRecorder()
    expect(badge()?.shadowRoot?.textContent).toContain('演示录制中')
    Object.defineProperty(window.navigator, 'language', { configurable: true, value: 'en-US' })
    runRecorder()
    expect(badge()?.shadowRoot?.textContent).toContain('Recording')
  })
})
