import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SoftPauseGate } from '../src/host/soft-pause/gate.ts'
import { installSoftPause } from '../src/host/soft-pause/live.ts'

interface Header {
  readonly id: string
  readonly origin?: 'subagent'
  readonly parentSession?: string
}

interface FakeSession {
  readonly id: string
  readonly header: Header
}

type Step = (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>

function session(id: string, header: Partial<Header> = {}): FakeSession {
  return { id, header: { id, ...header } }
}

function child(id: string, parentSession: string): FakeSession {
  return session(id, { origin: 'subagent', parentSession })
}

/**
 * Wire the real hook into a fake ctx that captures the `agent/pre-step`
 * listener, with a `sessions` store holding the lineage.
 */
function harness(sessions: readonly FakeSession[]) {
  const gate = new SoftPauseGate()
  const store = new Map(sessions.map(entry => [entry.id, entry]))
  let step: Step | undefined
  const ctx = {
    on: (_name: string, listener: Step) => {
      step = listener
    },
    get: (name: string) => (name === 'sessions'
      ? { get: (id: string) => store.get(id) }
      : undefined),
  } as unknown as Context
  installSoftPause(ctx, { gate, enabled: () => true })
  return {
    gate,
    run: async (agentSession: FakeSession, signal: AbortSignal, next: () => Promise<unknown> = async () => ({ kind: 'enter' })) =>
      await step!({ agent: { session: agentSession }, signal }, next),
  }
}

const enter = () => Promise.resolve({ kind: 'enter' })

/** Let queued microtasks run so a wrongly-unblocked step would have advanced. */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

describe('soft pause across subagent lineage', () => {
  it('holds a subagent step while its parent session is paused', async () => {
    const parent = session('parent')
    const kid = child('child', 'parent')
    const { gate, run } = harness([parent, kid])
    gate.engage('parent')

    let advanced = false
    const step = run(kid, new AbortController().signal, async () => {
      advanced = true
      return enter()
    })
    await settle()
    expect(advanced).toBe(false)

    gate.release('parent')
    await step
    expect(advanced).toBe(true)
  })

  it('walks more than one subagent level', async () => {
    const root = session('root')
    const middle = child('middle', 'root')
    const leaf = child('leaf', 'middle')
    const { gate, run } = harness([root, middle, leaf])
    gate.engage('root')

    let advanced = false
    const step = run(leaf, new AbortController().signal, async () => {
      advanced = true
      return enter()
    })
    await settle()
    expect(advanced).toBe(false)

    gate.release('root')
    await step
    expect(advanced).toBe(true)
  })

  it('does not inherit a pause through an ordinary fork', async () => {
    // A fork keeps the source id in `parentSession` but is its own conversation.
    const source = session('source')
    const fork = session('fork', { parentSession: 'source' })
    const { gate, run } = harness([source, fork])
    gate.engage('source')

    let advanced = false
    await run(fork, new AbortController().signal, async () => {
      advanced = true
      return enter()
    })
    expect(advanced).toBe(true)
  })

  it('does not hold the parent when only a child is paused', async () => {
    const parent = session('parent')
    const kid = child('child', 'parent')
    const { gate, run } = harness([parent, kid])
    gate.engage('child')

    let advanced = false
    await run(parent, new AbortController().signal, async () => {
      advanced = true
      return enter()
    })
    expect(advanced).toBe(true)
  })

  it('keeps the parent paused when the child step is aborted', async () => {
    const parent = session('parent')
    const kid = child('child', 'parent')
    const { gate, run } = harness([parent, kid])
    gate.engage('parent')

    const controller = new AbortController()
    let advanced = false
    const step = run(kid, controller.signal, async () => {
      advanced = true
      return enter()
    })
    await settle()
    controller.abort()
    const decision = await step
    expect(advanced).toBe(false)
    expect(decision).toEqual({ kind: 'reject' })
    expect(gate.isEngaged('parent')).toBe(true)
  })

  it('releases a held child once every engaged ancestor resumes', async () => {
    const root = session('root')
    const middle = child('middle', 'root')
    const leaf = child('leaf', 'middle')
    const { gate, run } = harness([root, middle, leaf])
    gate.engage('root')
    gate.engage('middle')

    let advanced = false
    const step = run(leaf, new AbortController().signal, async () => {
      advanced = true
      return enter()
    })
    await settle()
    gate.release('root')
    await settle()
    expect(advanced).toBe(false)

    gate.release('middle')
    await step
    expect(advanced).toBe(true)
  })
})
