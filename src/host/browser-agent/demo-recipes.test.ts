import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DemoStep } from './demo.ts'
import { DemoRecipeStore, MAX_RECIPE_STEPS, MAX_RECIPES, applyRecipeVars, missingRecipeVars, sanitizeRecipeSteps } from './demo-recipes.ts'
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

describe('DemoRecipeStore', () => {  it('saves, lists and reloads a flow', () => {
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

  it('renames a flow without touching its steps', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '旧名字', steps: [click('a'), click('b')], now: 1000 })
    if (!saved.ok) throw new Error('expected ok')
    const renamed = store.rename({ id: saved.recipe.id, name: '  新名字 ', now: 2000 })
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) throw new Error('expected ok')
    expect(renamed.recipe).toMatchObject({ name: '新名字', steps: 2, createdAt: 1000, updatedAt: 2000 })
  })

  it('refuses a rename that collides with another flow', () => {
    const { store } = tempStore()
    store.save({ name: 'a', steps: [click('a')] })
    const second = store.save({ name: 'b', steps: [click('b')] })
    if (!second.ok) throw new Error('expected ok')
    expect(store.rename({ id: second.recipe.id, name: 'A' })).toMatchObject({ ok: false })
    expect(store.rename({ id: 'missing', name: 'c' })).toMatchObject({ ok: false })
  })

  it('caps the number of saved flows', () => {
    const { store } = tempStore()
    for (let i = 0; i < MAX_RECIPES; i += 1) {
      expect(store.save({ name: `flow ${i}`, steps: [click('a')], now: 1000 + i }).ok).toBe(true)
    }
    expect(store.save({ name: 'one too many', steps: [click('a')] })).toMatchObject({ ok: false })
  })

  it('drops volatile tab ids but keeps the page url', () => {
    const { store, file } = tempStore()
    store.save({
      name: 'multi tab',
      steps: [
        { ...click('导出'), tabId: 1, tabUrl: 'https://example.com/a' } as DemoStep,
        { ...click('确认'), tabId: 2, tabUrl: 'https://example.com/b' } as DemoStep,
      ],
    })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('"tabId"')
    expect(raw).toContain('"tabUrl": "https://example.com/b"')
    const reloaded = new DemoRecipeStore(file).get(store.list()[0]!.id)?.steps ?? []
    expect(reloaded.every(step => step.tabId === undefined)).toBe(true)
    expect(reloaded.map(step => step.tabUrl)).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('strips a tab id that an older recipe still carries', () => {
    const { store, file } = tempStore()
    writeFileSync(file, JSON.stringify({
      version: 1,
      recipes: [{
        id: 'old', name: 'old', createdAt: 1, updatedAt: 1,
        steps: [{ kind: 'click', at: 1, role: 'button', name: 'a', selector: '#a', tabId: 7, tabUrl: 'https://example.com/x' }],
      }],
    }), 'utf8')
    const steps = store.get('old')?.steps ?? []
    expect(steps).toHaveLength(1)
    expect(steps[0]!.tabId).toBeUndefined()
    expect(steps[0]!.tabUrl).toBe('https://example.com/x')
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

describe('recipe parameters', () => {
  const withDate = (): DemoStep[] => [
    { kind: 'navigate', at: 1, url: 'https://example.com/reports?from=2026-11-01' },
    fill('开始日期', '2026-11-01', 2),
    click('导出', 3),
  ]

  it('turns a fill step into a token and remembers the old value', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: withDate(), now: 1000 })
    if (!saved.ok) throw new Error('expected ok')
    const result = store.parameterize({ id: saved.recipe.id, index: 1, name: 'from', now: 2000 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.recipe.variables).toEqual([{ name: 'from', default: '2026-11-01' }])
    const steps = store.get(saved.recipe.id)?.steps ?? []
    expect(steps[1]).toMatchObject({ kind: 'fill', value: '${from}' })
    expect(steps[0]).toMatchObject({ kind: 'navigate', url: 'https://example.com/reports?from=2026-11-01' })
  })

  it('refuses bad names, repeats, secrets and non-fill steps', () => {
    const { store } = tempStore()
    const saved = store.save({
      name: 'x',
      steps: [click('a'), fill('密码', '***', 2, true), fill('q', 'coffee', 3)],
    }, )
    if (!saved.ok) throw new Error('expected ok')
    const id = saved.recipe.id
    expect(store.parameterize({ id, index: 2, name: '1bad' })).toMatchObject({ ok: false })
    expect(store.parameterize({ id, index: 0, name: 'ok' })).toMatchObject({ ok: false })
    expect(store.parameterize({ id, index: 1, name: 'pw' })).toMatchObject({ ok: false })
    expect(store.parameterize({ id, index: 2, name: 'term' }).ok).toBe(true)
    expect(store.parameterize({ id, index: 2, name: 'term' })).toMatchObject({ ok: false })
    expect(store.parameterize({ id, index: 2, name: 'other' })).toMatchObject({ ok: false })
  })

  it('substitutes values into fills and navigations', () => {
    const steps = applyRecipeVars(
      [
        { kind: 'navigate', at: 1, url: 'https://example.com/r?from=${from}' },
        { kind: 'fill', at: 2, role: 'textbox', name: 'q', selector: '#q', field: 'q', value: '${term}', masked: false },
        click('导出', 3),
      ],
      { from: '2026-10-01', term: '季报' },
    )
    expect(steps[0]).toMatchObject({ url: 'https://example.com/r?from=2026-10-01' })
    expect(steps[1]).toMatchObject({ value: '季报' })
    expect(steps[2]).toMatchObject({ name: '导出' })
  })

  it('leaves an unknown token alone', () => {
    const steps = applyRecipeVars([fill('q', 'x ${missing}', 1)], {})
    expect(steps[0]).toMatchObject({ value: 'x ${missing}' })
  })

  it('reports variables that still need a value', () => {
    expect(missingRecipeVars({ variables: [{ name: 'a', default: '' }, { name: 'b', default: 'd' }] }, { a: '1' }))
      .toEqual(['b'])
    expect(missingRecipeVars({ variables: [{ name: 'a', default: 'x' }] }, {})).toEqual(['a'])
    expect(missingRecipeVars({ variables: [] }, {})).toEqual([])
  })

  it('drops malformed variables from an old file', () => {
    const { store, file } = tempStore()
    writeFileSync(file, JSON.stringify({
      version: 1,
      recipes: [{
        id: 'r1', name: 'x', createdAt: 1, updatedAt: 1,
        steps: [click('a')],
        variables: [{ name: 'ok', default: 'v' }, { name: '1bad', default: 'x' }, null],
      }],
    }), 'utf8')
    expect(store.list()[0]?.variables).toEqual([{ name: 'ok', default: 'v' }])
  })
})
