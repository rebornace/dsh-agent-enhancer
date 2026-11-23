import { describe, expect, it } from 'vitest'
import {
  isTreeRunning,
  sessionLineage,
} from '../src/host/soft-pause/lineage.ts'
import type { AgentLike, SessionLike } from '../src/host/soft-pause/lineage.ts'

interface FakeSession extends SessionLike {
  readonly id: string
  readonly header: { id: string; origin?: string; parentSession?: string }
}

function session(id: string, header: { origin?: string; parentSession?: string } = {}): FakeSession {
  return { id, header: { id, ...header } }
}

function child(id: string, parentSession: string): FakeSession {
  return session(id, { origin: 'subagent', parentSession })
}

function store(sessions: readonly FakeSession[]) {
  const map = new Map(sessions.map(entry => [entry.id, entry]))
  return { get: (id: string) => map.get(id) }
}

function agent(status: string, entry: FakeSession): AgentLike {
  return { status, session: entry }
}

describe('sessionLineage', () => {
  it('walks subagent ancestors and stops at the root', () => {
    const root = session('root')
    const middle = child('middle', 'root')
    const leaf = child('leaf', 'middle')
    expect(sessionLineage(leaf, store([root, middle, leaf]))).toEqual(['leaf', 'middle', 'root'])
  })

  it('stops at an ordinary fork', () => {
    const source = session('source')
    const fork = session('fork', { parentSession: 'source' })
    expect(sessionLineage(fork, store([source, fork]))).toEqual(['fork'])
  })

  it('keeps the parent id when the store cannot resolve it', () => {
    const leaf = child('leaf', 'ghost')
    expect(sessionLineage(leaf, store([leaf]))).toEqual(['leaf', 'ghost'])
  })
})

describe('isTreeRunning', () => {
  const root = session('root')
  const kid = child('child', 'root')
  const grandkid = child('grandchild', 'child')

  it('reports work running in a child after the parent turn ended', () => {
    expect(isTreeRunning('root', [agent('idle', root), agent('running', kid)], store([root, kid]))).toBe(true)
  })

  it('reports work running two levels down', () => {
    expect(isTreeRunning('root', [agent('running', grandkid)], store([root, kid, grandkid]))).toBe(true)
  })

  it('ignores idle children and unrelated trees', () => {
    const other = session('other')
    const otherKid = child('other-child', 'other')
    expect(isTreeRunning('root', [agent('idle', kid)], store([root, kid]))).toBe(false)
    expect(isTreeRunning('root', [agent('running', otherKid)], store([other, otherKid]))).toBe(false)
  })

  it('does not count a fork of this session as its child', () => {
    const fork = session('fork', { parentSession: 'root' })
    expect(isTreeRunning('root', [agent('running', fork)], store([root, fork]))).toBe(false)
  })

  it('counts a running root itself', () => {
    expect(isTreeRunning('root', [agent('running', root)], store([root]))).toBe(true)
  })
})
