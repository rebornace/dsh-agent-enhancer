import { describe, expect, it } from 'vitest'
import { selectSnapshotRows } from './playwright-snapshot.ts'

type Row = { readonly priority: number; readonly name: string }

const row = (priority: number, name: string): Row => ({ priority, name })

describe('selectSnapshotRows', () => {
  it('keeps form controls when a page is dense with links', () => {
    const links = Array.from({ length: 90 }, (_, i) => row(0, `link-${i}`))
    const controls = [row(1, 'search'), row(1, 'submit'), row(1, 'email')]
    const anchors = Array.from({ length: 20 }, (_, i) => row(2, `anchor-${i}`))

    const names = selectSnapshotRows([...links, ...controls, ...anchors], 80).map(item => item.name)
    expect(names).toHaveLength(80)
    for (const control of ['search', 'submit', 'email']) expect(names).toContain(control)
    expect(names.some(name => name.startsWith('anchor-'))).toBe(false)
  })

  it('reserves half the budget for controls on a form-heavy page', () => {
    const controls = Array.from({ length: 60 }, (_, i) => row(1, `control-${i}`))
    const links = Array.from({ length: 200 }, (_, i) => row(0, `link-${i}`))
    const names = selectSnapshotRows([...links, ...controls], 80).map(item => item.name)
    expect(names).toHaveLength(80)
    expect(names.filter(name => name.startsWith('control-'))).toHaveLength(40)
    expect(names.filter(name => name.startsWith('link-'))).toHaveLength(40)
  })

  it('includes geometry-only anchors only while budget allows', () => {
    const rows = [
      row(2, 'anchor-a'),
      row(0, 'link-a'),
      row(1, 'button-a'),
      row(2, 'anchor-b'),
    ]
    // Display order: controls first, then links, then inferred anchors.
    expect(selectSnapshotRows(rows, 80).map(item => item.name))
      .toEqual(['button-a', 'link-a', 'anchor-a', 'anchor-b'])
    // Two slots: the anchor loses both of them to a real control and a real link.
    expect(selectSnapshotRows(rows, 2).map(item => item.name)).toEqual(['button-a', 'link-a'])
  })

  it('puts controls first and keeps the incoming order inside a group', () => {
    const selected = selectSnapshotRows([
      row(0, 'a'),
      row(1, 'b'),
      row(0, 'c'),
      row(1, 'd'),
    ], 4)
    expect(selected.map(item => item.name)).toEqual(['b', 'd', 'a', 'c'])
    expect(selectSnapshotRows([row(0, 'a')], 0)).toEqual([])
    expect(selectSnapshotRows([], 80)).toEqual([])
  })
})
