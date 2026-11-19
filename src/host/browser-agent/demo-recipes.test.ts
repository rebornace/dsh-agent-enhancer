import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DemoStep } from './demo.ts'
import { DemoRecipeStore, MAX_RECIPE_STEPS, MAX_RECIPES, sanitizeRecipeSteps } from './demo-recipes.ts'

const click = (name: string, at = 1): DemoStep => ({ kind: 'click', at, role: 'button', name, selector: '#x' })
const fill = (name: string, value: string, at = 2, masked = false): DemoStep => ({
  kind: 'fill', at, role: 'textbox', name, selector: '#f', field: 'q', value, masked,
})

const dirs: string[] = []
function tempStore(): { store: DemoRecipeStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-recipes-'))
  dirs.push(dir)
  const file = join(dir, 'demo-recipes.json')
  return { store: new DemoRecipeStore(file), file }
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('DemoRecipeStore', () => {
  it('saves, lists and reloads a flow', () => {
    const { store, file } = tempStore()
    const result = store.save({ name: '导出报表', steps: [click('导出'), fill('日期', '2026-11-01')], now: 1000 })
    expect(result.ok).toBe(true)
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '导出报表', steps: 2, createdAt: 1000, updatedAt: 1000 })
    const reloaded = new DemoRecipeStore(file).list()
    expect(reloaded.map(item => item.name)).toEqual(['导出报表'])
  })

  it('updates in place when the same name is saved again (case-insensitive)', () => {
    const { store } = tempStore()
    const first = store.save({ name: 'Export', steps: [click('a')], now: 1000 })
    const second = store.save({ name: '  export ', steps: [click('a'), click('b')], now: 2000 })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('expected ok')
    expect(second.recipe.id).toBe(first.recipe.id)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ name: 'export', steps: 2, createdAt: 1000, updatedAt: 2000 })
  })

  it('refuses an empty name or an empty flow', () => {
    const { store } = tempStore()
    expect(store.save({ name: '   ', steps: [click('a')] })).toMatchObject({ ok: false })
    expect(store.save({ name: 'x', steps: [] })).toMatchObject({ ok: false })
  })

  it('removes a flow by id and reports whether it existed', () => {
    const { store } = tempStore()
    const saved = store.save({ name: 'a', steps: [click('a')] })
    if (!saved.ok) throw new Error('expected ok')
    expect(store.remove('nope')).toBe(false)
    expect(store.remove(saved.recipe.id)).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('caps the number of saved flows', () => {
    const { store } = tempStore()
    for (let i = 0; i < MAX_RECIPES; i += 1) {
      expect(store.save({ name: `flow ${i}`, steps: [click('a')], now: 1000 + i }).ok).toBe(true)
    }
    expect(store.save({ name: 'one too many', steps: [click('a')] })).toMatchObject({ ok: false })
  })

  it('keeps secrets masked when saving', () => {
    const { store, file } = tempStore()
    store.save({ name: 'login', steps: [fill('Password', 'hunter2'), fill('email', 'me@example.com')] })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('hunter2')
    const steps = new DemoRecipeStore(file).get(store.list()[0]!.id)?.steps ?? []
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatchObject({ masked: true, value: '***' })
  })

  it('survives a corrupt file and drops malformed steps', () => {
    const { store, file } = tempStore()
    writeFileSync(file, '{not json', 'utf8')
    expect(store.list()).toEqual([])
    writeFileSync(file, JSON.stringify({
      version: 1,
      recipes: [{
        id: 'r1', name: 'ok', createdAt: 1, updatedAt: 2,
        steps: [{ kind: 'nope' }, { kind: 'click', at: 1, role: 'button', name: 'a', selector: '#a' }],
      }, { id: 'r2', name: 'empty', createdAt: 1, updatedAt: 1, steps: [] }],
    }), 'utf8')
    const list = store.list()
    expect(list.map(item => item.name)).toEqual(['ok'])
    expect(list[0]!.steps).toBe(1)
  })

  it('filters and caps raw steps', () => {
    const raw = Array.from({ length: MAX_RECIPE_STEPS + 5 }, (_, index) => click(`c${index}`, index))
    expect(sanitizeRecipeSteps(raw)).toHaveLength(MAX_RECIPE_STEPS)
    expect(sanitizeRecipeSteps('nope')).toEqual([])
  })

  it('works without a file (in-memory only)', () => {
    const store = new DemoRecipeStore(null)
    expect(store.save({ name: 'a', steps: [click('a')] }).ok).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ name: 'a', steps: 1 })
  })
})
