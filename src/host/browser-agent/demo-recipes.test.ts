import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DemoStep } from './demo.ts'
import { DemoRecipeStore, MAX_RECIPE_STEPS, MAX_RECIPES, applyRecipeVars, missingRecipeVars, prepareRecipeValues, sanitizeRecipeSteps } from './demo-recipes.ts'
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
    expect(result.recipe.variables).toEqual([{ name: 'from', label: '开始日期', default: '2026-11-01', ask: false }])
    const steps = store.get(saved.recipe.id)?.steps ?? []
    expect(steps[1]).toMatchObject({ kind: 'fill', value: '${from}' })
    expect(steps[0]).toMatchObject({ kind: 'navigate', url: 'https://example.com/reports?from=2026-11-01' })
  })

  it('generates a token id and labels the variable from the page', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: [fill('开始日期', '2026-11-01')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    const result = store.parameterize({ id: saved.recipe.id, index: 0, now: 2_000 })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.recipe.variables).toEqual([{ name: 'v1', label: '开始日期', default: '2026-11-01', ask: false }])
    expect(store.get(saved.recipe.id)?.steps[0]).toMatchObject({ value: '${v1}' })
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
    expect(missingRecipeVars({ variables: [{ name: 'a', label: 'a', default: '', ask: false }, { name: 'b', label: 'b', default: 'd', ask: false }] }, { a: '1' }))
      .toEqual(['b'])
    expect(missingRecipeVars({ variables: [{ name: 'a', label: 'a', default: 'x', ask: false }] }, {})).toEqual(['a'])
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
    expect(store.list()[0]?.variables).toEqual([{ name: 'ok', label: 'ok', default: 'v', ask: false }])
  })
})

describe('repairs and versions', () => {
  const proposal = {
    id: 'h-1',
    at: 5_000,
    failedAt: 2,
    reason: 'no control matching button "导出报表"',
    inserted: [click('同意', 3)],
    replacement: { kind: 'click', at: 2, role: 'button', name: '导出报表（新）', selector: '#new' } as DemoStep,
  }

  it('stores a repair without touching the steps', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '导出', steps: [click('打开'), click('导出报表')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    const recorded = store.recordHeal({ id: saved.recipe.id, proposal })
    expect(recorded.ok).toBe(true)
    if (!recorded.ok) throw new Error('expected ok')
    expect(recorded.recipe.pendingHeal).toMatchObject({ failedAt: 2 })
    expect(recorded.recipe.steps).toBe(2)
    expect(recorded.recipe.rev).toBe(1)
    expect(store.get(saved.recipe.id)?.steps).toHaveLength(2)
  })

  it('drops a repair without changing the flow', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '导出', steps: [click('打开'), click('导出报表')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.recordHeal({ id: saved.recipe.id, proposal })
    const dropped = store.resolveHeal({ id: saved.recipe.id, accept: false, now: 2_000 })
    expect(dropped.ok).toBe(true)
    if (!dropped.ok) throw new Error('expected ok')
    expect(dropped.recipe.pendingHeal).toBeUndefined()
    expect(dropped.recipe.steps).toBe(2)
    expect(dropped.recipe.rev).toBe(1)
    expect(dropped.recipe.history).toBe(0)
  })

  it('accepts a repair: new steps, revision + 1, old version kept', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '导出', steps: [click('打开'), click('导出报表'), click('下载')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.recordHeal({ id: saved.recipe.id, proposal })
    const applied = store.resolveHeal({ id: saved.recipe.id, accept: true, now: 2_000 })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('expected ok')
    expect(applied.recipe.steps).toBe(4)
    expect(applied.recipe.rev).toBe(2)
    expect(applied.recipe.history).toBe(1)
    const steps = store.get(saved.recipe.id)?.steps ?? []
    expect(steps.map(step => ('name' in step ? step.name : step.kind)))
      .toEqual(['打开', '同意', '导出报表（新）', '下载'])
  })

  it('rolls back the last change and consumes that version', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '导出', steps: [click('打开'), click('导出报表')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.recordHeal({ id: saved.recipe.id, proposal })
    store.resolveHeal({ id: saved.recipe.id, accept: true, now: 2_000 })
    const restored = store.rollback({ id: saved.recipe.id, now: 3_000 })
    expect(restored.ok).toBe(true)
    if (!restored.ok) throw new Error('expected ok')
    expect(restored.recipe.steps).toBe(2)
    expect(restored.recipe.history).toBe(0)
    expect(restored.recipe.pendingHeal).toBeUndefined()
    const steps = store.get(saved.recipe.id)?.steps ?? []
    expect(steps.map(step => ('name' in step ? step.name : step.kind))).toEqual(['打开', '导出报表'])
    expect(store.rollback({ id: saved.recipe.id })).toMatchObject({ ok: false })
  })

  it('keeps a version when a recording overwrites an existing flow', () => {
    const { store } = tempStore()
    const first = store.save({ name: '导出', steps: [click('a')], now: 1_000 })
    if (!first.ok) throw new Error('expected ok')
    const second = store.save({ name: '导出', steps: [click('a'), click('b')], now: 2_000 })
    if (!second.ok) throw new Error('expected ok')
    expect(second.recipe.rev).toBe(2)
    expect(second.recipe.history).toBe(1)
    const rolled = store.rollback({ id: first.recipe.id })
    expect(rolled.ok && rolled.recipe.steps).toBe(1)
  })

  it('keeps versions when a step is parameterised', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: [click('打开'), fill('日期', '2026-11-01')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    const parameterized = store.parameterize({ id: saved.recipe.id, index: 1, name: 'from', now: 2_000 })
    expect(parameterized.ok && parameterized.recipe.rev).toBe(2)
    expect(parameterized.ok && parameterized.recipe.history).toBe(1)
  })

  it('reads a v1 file (no revisions) without losing the flow', () => {
    const { store, file } = tempStore()
    writeFileSync(file, JSON.stringify({
      version: 1,
      recipes: [{
        id: 'r1', name: '旧流程', createdAt: 1, updatedAt: 1,
        steps: [click('a')],
        variables: [],
      }],
    }), 'utf8')
    const list = store.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '旧流程', rev: 1, history: 0 })
    expect(list[0]?.pendingHeal).toBeUndefined()
  })

  it('survives a re-read with the repair intact', () => {
    const { store, file } = tempStore()
    const saved = store.save({ name: '导出', steps: [click('打开'), click('导出报表')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.recordHeal({ id: saved.recipe.id, proposal })
    const reloaded = new DemoRecipeStore(file).list()
    expect(reloaded[0]?.pendingHeal).toMatchObject({ id: 'h-1', failedAt: 2 })
    expect(reloaded[0]?.pendingHeal?.replacement).toMatchObject({ name: '导出报表（新）' })
  })
})

describe('variable management', () => {
  it('renames, re-defaults and switches to ask-per-run', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: [fill('开始日期', '2026-11-01')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.parameterize({ id: saved.recipe.id, index: 0, name: 'v1', label: '开始日期', now: 2_000 })

    const renamed = store.updateVariable({ id: saved.recipe.id, name: 'v1', label: '统计开始', now: 3_000 })
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) throw new Error('expected ok')
    expect(renamed.recipe.variables[0]).toMatchObject({ label: '统计开始', default: '2026-11-01', ask: false })
    expect(renamed.recipe.rev).toBe(3)

    const asked = store.updateVariable({ id: saved.recipe.id, name: 'v1', ask: true, now: 4_000 })
    expect(asked.ok && asked.recipe.variables[0]?.ask).toBe(true)
    expect(asked.ok && asked.recipe.rev).toBe(4)
  })

  it('turns the variable back into the recorded text', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: [fill('开始日期', '2026-11-01')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.parameterize({ id: saved.recipe.id, index: 0, name: 'v1', now: 2_000 })
    expect(store.get(saved.recipe.id)?.steps[0]).toMatchObject({ value: '$' + '{v1}' })

    const reverted = store.removeVariable({ id: saved.recipe.id, name: 'v1', now: 3_000 })
    expect(reverted.ok).toBe(true)
    if (!reverted.ok) throw new Error('expected ok')
    expect(reverted.recipe.variables).toEqual([])
    expect(store.get(saved.recipe.id)?.steps[0]).toMatchObject({ value: '2026-11-01' })
    expect(reverted.recipe.rev).toBe(3)
    expect(reverted.recipe.history).toBe(2)
    expect(store.removeVariable({ id: saved.recipe.id, name: 'v1' })).toMatchObject({ ok: false })
  })

  it('an ask variable never prefills its default', () => {
    const recipe = {
      variables: [
        { name: 'v1', label: '开始日期', default: '2026-11-01', ask: true },
        { name: 'v2', label: '关键词', default: '周报', ask: false },
      ],
    }
    const prepared = prepareRecipeValues(recipe, {}, new Date(2026, 10, 20))
    expect(prepared.values).toEqual({ v1: '', v2: '周报' })
    expect(prepared.missing.map(variable => variable.label)).toEqual(['开始日期'])
    expect(prepareRecipeValues(recipe, { 开始日期: '上周' }, new Date(2026, 10, 20)).values.v1).toBe('2026-11-09')
  })

  it('keeps the unattended flag off until the user turns it on', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: [click('导出')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    expect(saved.recipe.unattended).toBe(false)

    const on = store.setUnattended({ id: saved.recipe.id, unattended: true, now: 2_000 })
    expect(on.ok && on.recipe.unattended).toBe(true)
    // A policy flag, not flow content: the revision does not move.
    expect(store.list()[0]?.rev).toBe(1)

    const off = store.setUnattended({ id: saved.recipe.id, unattended: false })
    expect(off.ok && off.recipe.unattended).toBe(false)
    expect(store.setUnattended({ id: 'missing', unattended: true })).toMatchObject({ ok: false })
  })

  it('records the last run without touching the flow content', () => {
    const { store, file } = tempStore()
    const saved = store.save({ name: '周报', steps: [click('导出')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    expect(saved.recipe.lastRun).toBeUndefined()

    expect(store.recordRun({
      id: saved.recipe.id,
      result: { at: 5_000, status: 'stopped', performed: 2, total: 5, reason: 'no control matching button "导出"' },
    })).toBe(true)
    expect(store.list()[0]?.lastRun).toMatchObject({ status: 'stopped', performed: 2, total: 5 })
    expect(store.list()[0]?.rev).toBe(1)
    expect(store.recordRun({ id: 'missing', result: { at: 1, status: 'ok', performed: 0, total: 0 } })).toBe(false)

    // A malformed history entry must not take the flow down.
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.recipes[0].lastRun = { at: 'soon', status: 'weird', performed: 1, total: 1 }
    writeFileSync(file, JSON.stringify(raw), 'utf8')
    expect(store.list()[0]?.lastRun).toBeUndefined()
  })

  it('rejects a blank label', () => {
    const { store } = tempStore()
    const saved = store.save({ name: '周报', steps: [fill('开始日期', '2026-11-01')], now: 1_000 })
    if (!saved.ok) throw new Error('expected ok')
    store.parameterize({ id: saved.recipe.id, index: 0, name: 'v1', now: 2_000 })
    expect(store.updateVariable({ id: saved.recipe.id, name: 'v1', label: '   ' })).toMatchObject({ ok: false })
  })
})
