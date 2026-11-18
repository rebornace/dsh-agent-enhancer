import { describe, expect, it, vi } from 'vitest'
import { SoftPauseGate } from '../src/host/soft-pause/gate.ts'

describe('SoftPauseGate', () => {
  it('does not block when not engaged', async () => {
    const gate = new SoftPauseGate()
    const signal = new AbortController().signal
    await expect(gate.waitIfEngaged('s1', signal)).resolves.toBeUndefined()
  })

  it('holds waiters until release, then allows one pass', async () => {
    const gate = new SoftPauseGate()
    gate.engage('s1')
    expect(gate.isEngaged('s1')).toBe(true)

    let released = false
    const waiting = gate.waitIfEngaged('s1', new AbortController().signal).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)

    gate.release('s1')
    await waiting
    expect(released).toBe(true)
    expect(gate.isEngaged('s1')).toBe(false)

    await expect(gate.waitIfEngaged('s1', new AbortController().signal)).resolves.toBeUndefined()
  })

  it('clears engaged on abort and settles waiters', async () => {
    const gate = new SoftPauseGate()
    gate.engage('s1')
    const controller = new AbortController()
    const waiting = gate.waitIfEngaged('s1', controller.signal)
    await Promise.resolve()
    controller.abort()
    await waiting
    expect(gate.isEngaged('s1')).toBe(false)
  })

  it('resume only releases once per engage', async () => {
    const gate = new SoftPauseGate()
    gate.engage('s1')
    const first = vi.fn()
    const second = vi.fn()
    const a = gate.waitIfEngaged('s1', new AbortController().signal).then(first)
    const b = gate.waitIfEngaged('s1', new AbortController().signal).then(second)
    await Promise.resolve()
    gate.release('s1')
    await Promise.all([a, b])
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(gate.isEngaged('s1')).toBe(false)
  })
})
