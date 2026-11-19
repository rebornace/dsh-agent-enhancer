/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEMO_RECORDER_SOURCE, DEMO_STOP_SOURCE, type DemoStep } from './demo.ts'

const runRecorder = (): unknown => new Function(DEMO_RECORDER_SOURCE)()
const runStop = (): unknown => new Function(`return ${DEMO_STOP_SOURCE}`)()

const collected: DemoStep[] = []
;(window as unknown as { __dshDemoPush: (step: DemoStep) => void }).__dshDemoPush = step => {
  collected.push(step)
}

/** The wrapper records on the next tick, after the app finishes its route change. */
const nextTick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('single-page route recording', () => {
  beforeEach(() => {
    runStop()
    collected.length = 0
    window.history.replaceState(null, '', '/start')
  })

  it('records a pushState route as a navigate step', async () => {
    runRecorder()
    window.history.pushState({ page: 'reports' }, '', '/reports?range=2026-11')
    await nextTick()
    expect(collected).toHaveLength(1)
    expect(collected[0]).toMatchObject({ kind: 'navigate', url: 'http://localhost:3000/reports?range=2026-11' })
  })

  it('records replaceState and ignores a rewrite to the same URL', async () => {
    runRecorder()
    window.history.replaceState(null, '', '/a')
    await nextTick()
    window.history.replaceState(null, '', '/a')
    await nextTick()
    window.history.replaceState(null, '', '/b')
    await nextTick()
    expect(collected.map(step => step.kind === 'navigate' ? step.url : '')).toEqual([
      'http://localhost:3000/a',
      'http://localhost:3000/b',
    ])
  })

  it('records a hash route change', async () => {
    runRecorder()
    window.location.hash = '#/settings'
    await new Promise(resolve => { window.addEventListener('hashchange', resolve, { once: true }) })
    await nextTick()
    expect(collected).toHaveLength(1)
    expect(collected[0]).toMatchObject({ kind: 'navigate' })
  })

  it('stops recording route changes once the recorder is stopped', async () => {
    runRecorder()
    runStop()
    window.history.pushState(null, '', '/after-stop')
    await nextTick()
    expect(collected).toEqual([])
  })
})
