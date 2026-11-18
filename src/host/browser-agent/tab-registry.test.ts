import { describe, expect, it } from 'vitest'
import { TabRegistry } from './tab-registry.ts'

interface FakeRef {
  readonly ref: number
  readonly name: string
}

const page = (name: string): object => ({ name })

describe('TabRegistry', () => {
  it('keeps ids stable when other tabs open or close', () => {
    const tabs = new TabRegistry<FakeRef>()
    const a = page('a')
    const b = page('b')
    const c = page('c')

    const idA = tabs.idOf(a)
    tabs.idOf(b)
    expect(tabs.idOf(a)).toBe(idA)

    tabs.release(a)
    expect(tabs.idOf(b)).toBeGreaterThan(idA)
    expect(tabs.page(idA)).toBeUndefined()

    // A closed id is retired: a new page must never inherit it.
    const idC = tabs.idOf(c)
    expect(idC).toBeGreaterThan(idA)
    expect(tabs.page(idC)).toBe(c)
  })

  it('keeps refs with the tab that produced them', () => {
    const tabs = new TabRegistry<FakeRef>()
    const a = page('a')
    const b = page('b')
    const idA = tabs.idOf(a)
    const idB = tabs.idOf(b)

    tabs.setRefs(idA, [[1, { ref: 1, name: 'A one' }]])
    tabs.setRefs(idB, [[1, { ref: 1, name: 'B one' }]])

    expect(tabs.ref(idA, 1)?.name).toBe('A one')
    expect(tabs.ref(idB, 1)?.name).toBe('B one')

    // A newer snapshot in B must not disturb A.
    tabs.setRefs(idB, [[2, { ref: 2, name: 'B two' }]])
    expect(tabs.ref(idB, 1)).toBeUndefined()
    expect(tabs.ref(idA, 1)?.name).toBe('A one')
  })

  it('clears refs for one tab only', () => {
    const tabs = new TabRegistry<FakeRef>()
    const idA = tabs.idOf(page('a'))
    const idB = tabs.idOf(page('b'))
    tabs.setRefs(idA, [[1, { ref: 1, name: 'A' }]])
    tabs.setRefs(idB, [[1, { ref: 1, name: 'B' }]])

    tabs.clearRefs(idB)
    expect(tabs.refsOf(idB).size).toBe(0)
    expect(tabs.refsOf(idA).size).toBe(1)
  })

  it('names the tab that still holds a misplaced ref', () => {
    const tabs = new TabRegistry<FakeRef>()
    const idA = tabs.idOf(page('a'))
    const idB = tabs.idOf(page('b'))
    tabs.setRefs(idA, [[7, { ref: 7, name: 'A seven' }]])

    expect(tabs.unknownRefMessage(7, idB)).toContain(`belongs to tab ${idA}`)
    expect(tabs.unknownRefMessage(7, idB)).toContain('browser_snapshot')
    expect(tabs.unknownRefMessage(99, idB)).toBe('Unknown ref 99; call browser_snapshot first')
  })

  it('drops refs when the tab closes', () => {
    const tabs = new TabRegistry<FakeRef>()
    const a = page('a')
    const idA = tabs.idOf(a)
    tabs.setRefs(idA, [[1, { ref: 1, name: 'A' }]])

    tabs.release(a)
    expect(tabs.refsOf(idA).size).toBe(0)
    expect(tabs.tabHolding(1, idA)).toBeUndefined()
  })
})
