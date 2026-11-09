import { describe, expect, it } from 'vitest'
import { BrowserHumanGate } from './human-gate.ts'

describe('BrowserHumanGate', () => {
  it('blocks until acknowledge, then returns continued', async () => {
    const gate = new BrowserHumanGate()
    const controller = new AbortController()
    const wait = gate.waitForHuman({
      sessionId: 's1',
      prompt: 'Please log in',
      detail: 'login',
      signal: controller.signal,
    })
    expect(gate.current()?.sessionId).toBe('s1')
    expect(gate.acknowledge('s1')).toBe(true)
    await expect(wait).resolves.toBe('continued')
    expect(gate.current()).toBeNull()
  })

  it('rejects when aborted', async () => {
    const gate = new BrowserHumanGate()
    const controller = new AbortController()
    const wait = gate.waitForHuman({
      sessionId: 's1',
      prompt: 'wait',
      detail: 'd',
      signal: controller.signal,
    })
    controller.abort()
    await expect(wait).rejects.toThrow(/aborted/i)
    expect(gate.current()).toBeNull()
  })

  it('clearSession cancels waiters', async () => {
    const gate = new BrowserHumanGate()
    const controller = new AbortController()
    const wait = gate.waitForHuman({
      sessionId: 's1',
      prompt: 'wait',
      detail: 'd',
      signal: controller.signal,
    })
    gate.clearSession('s1')
    await expect(wait).resolves.toBe('cancelled')
  })
})
