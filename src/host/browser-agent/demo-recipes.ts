/**
 * Saved demonstrations: a flow the user recorded once, kept so it can be run
 * again without re-recording. Cross-session by design (the user wants "every
 * week, do this"), so it is not keyed by session and does not follow session
 * deletion; the panel owns an explicit delete.
 *
 * Only sanitized steps are stored: secrets stay `***`, and the file holds no
 * screenshots, cookies or request data.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sanitizeDemoSteps, type DemoStep } from './demo.ts'
import { applyHealProposal, type DemoHealProposal } from './demo-heal.ts'

/** A placeholder inside a flow: stored steps carry a `${name}` token instead of a literal. */
export interface RecipeVariable {
  readonly name: string
  readonly default: string
}

/** One past state of a flow, kept so a heal or an overwrite can be undone. */
export interface DemoRecipeVersion {
  readonly rev: number
  readonly at: number
  readonly source: 'save' | 'parameterize' | 'heal' | 'rollback'
  readonly steps: readonly DemoStep[]
  readonly variables: readonly RecipeVariable[]
}

export interface DemoRecipe {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly steps: readonly DemoStep[]
  readonly variables: readonly RecipeVariable[]
  /** Content revision, bumped by every change; proposals never bump it. */
  readonly rev: number
  /** Most recent past states, newest last (bounded). */
  readonly history: readonly DemoRecipeVersion[]
  /** A repair waiting for the user to accept it. */
  readonly pendingHeal?: DemoHealProposal
}

/** List entry: steps are counted, never sent, so the panel stays light. */
export interface DemoRecipeMeta {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly steps: number
  readonly variables: readonly RecipeVariable[]
  readonly rev: number
  readonly history: number
  readonly pendingHeal?: DemoHealProposal
}

export const MAX_RECIPES = 20
export const MAX_RECIPE_NAME = 60
export const MAX_RECIPE_STEPS = 200
/** Enough to walk back a bad heal or two, without turning the file into a log. */
export const MAX_HISTORY = 5
const FILE_VERSION = 2

interface FileShape {
  readonly version: number
  readonly recipes: readonly DemoRecipe[]
}

export type SaveResult =
  | { readonly ok: true; readonly recipe: DemoRecipeMeta }
  | { readonly ok: false; readonly error: string }

function metaOf(recipe: DemoRecipe): DemoRecipeMeta {
  return {
    id: recipe.id,
    name: recipe.name,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    steps: recipe.steps.length,
    variables: recipe.variables,
    rev: recipe.rev,
    history: recipe.history.length,
    ...(recipe.pendingHeal === undefined ? {} : { pendingHeal: recipe.pendingHeal }),
  }
}

/** Push the current content onto the bounded history (callers bump `rev`). */
function nextVersion(
  recipe: DemoRecipe,
  source: DemoRecipeVersion['source'],
  now: number,
): DemoRecipeVersion[] {
  return [
    ...recipe.history,
    { rev: recipe.rev, at: now, source, steps: recipe.steps, variables: recipe.variables },
  ].slice(-MAX_HISTORY)
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const VAR_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** Replace a variable token in fill values and navigate URLs; unknown names stay literal. */
export function applyRecipeVars(
  steps: readonly DemoStep[],
  values: Readonly<Record<string, string>>,
): DemoStep[] {
  const fill = (text: string): string => text.replace(VAR_TOKEN, (match, name: string) => values[name] ?? match)
  return steps.map(step => {
    if (step.kind === 'navigate') {
      const url = fill(step.url)
      return url === step.url ? step : { ...step, url }
    }
    if (step.kind === 'fill') {
      const value = fill(step.value)
      return value === step.value ? step : { ...step, value }
    }
    return step
  })
}

/** Variable names a flow still needs a value for (empty means ready to run). */
export function missingRecipeVars(
  recipe: { readonly variables: readonly RecipeVariable[] },
  values: Readonly<Record<string, string>>,
): string[] {
  return recipe.variables
    .filter(variable => (values[variable.name] ?? '').trim() === '')
    .map(variable => variable.name)
}

function sanitizeVariables(raw: unknown): RecipeVariable[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((value): value is RecipeVariable => {
      if (value === null || typeof value !== 'object') return false
      const name = (value as { name?: unknown }).name
      return typeof name === 'string' && VAR_NAME.test(name)
    })
    .map(variable => ({ name: variable.name, default: String(variable.default ?? '').slice(0, 500) }))
}

/** Old versions are read back leniently; a broken entry is dropped, not fatal. */
function sanitizeHistory(raw: unknown): DemoRecipeVersion[] {
  if (!Array.isArray(raw)) return []
  const versions: DemoRecipeVersion[] = []
  for (const value of raw) {
    if (value === null || typeof value !== 'object') continue
    const entry = value as Partial<DemoRecipeVersion>
    const steps = sanitizeRecipeSteps(entry.steps)
    if (steps.length === 0) continue
    versions.push({
      rev: Number.isFinite(entry.rev) && (entry.rev ?? 0) > 0 ? Number(entry.rev) : 1,
      at: Number.isFinite(entry.at) ? Number(entry.at) : 0,
      source: entry.source === 'parameterize' || entry.source === 'heal' || entry.source === 'rollback'
        ? entry.source
        : 'save',
      steps,
      variables: sanitizeVariables(entry.variables),
    })
  }
  return versions.slice(-MAX_HISTORY)
}

/** A stored repair must still point at a real step of a real flow. */
function sanitizeProposal(raw: unknown): DemoHealProposal | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const entry = raw as Partial<DemoHealProposal>
  if (typeof entry.id !== 'string' || entry.id === '') return undefined
  const failedAt = Number(entry.failedAt)
  if (!Number.isInteger(failedAt) || failedAt < 1) return undefined
  const replacement = sanitizeRecipeSteps(entry.replacement === undefined ? [] : [entry.replacement])[0]
  if (replacement === undefined) return undefined
  return {
    id: entry.id,
    at: Number.isFinite(entry.at) ? Number(entry.at) : 0,
    failedAt,
    reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 500) : '',
    inserted: sanitizeRecipeSteps(entry.inserted ?? []),
    replacement,
  }
}

function isStep(value: unknown): value is DemoStep {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'navigate' || kind === 'click' || kind === 'fill' || kind === 'press'
}

/** Keep only well-formed, sanitized steps; drop volatile handles (tab ids). */
export function sanitizeRecipeSteps(raw: unknown): DemoStep[] {
  if (!Array.isArray(raw)) return []
  const steps = raw.filter(isStep).slice(0, MAX_RECIPE_STEPS)
  return sanitizeDemoSteps(steps).map(step => {
    const { tabId: _volatileTabId, ...rest } = step
    return rest as DemoStep
  })
}

export class DemoRecipeStore {
  private memory: DemoRecipe[] = []

  constructor(private readonly filePath: string | null = null) {}

  list(): DemoRecipeMeta[] {
    return this.read().map(metaOf).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): DemoRecipe | undefined {
    return this.read().find(recipe => recipe.id === id)
  }

  /** Save under `name`; the same name (case-insensitive) updates in place. */
  save(input: { readonly name: string; readonly steps: readonly DemoStep[]; readonly now?: number }): SaveResult {
    const name = input.name.replace(/\s+/gu, ' ').trim()
    if (name === '') return { ok: false, error: '流程名不能为空' }
    if (name.length > MAX_RECIPE_NAME) return { ok: false, error: `流程名最长 ${MAX_RECIPE_NAME} 个字符` }
    const steps = sanitizeRecipeSteps(input.steps)
    if (steps.length === 0) return { ok: false, error: '这次录制没有可保存的步骤' }

    const now = input.now ?? Date.now()
    const recipes = this.read()
    const existing = recipes.find(recipe => recipe.name.toLowerCase() === name.toLowerCase())
    let saved: DemoRecipe
    if (existing !== undefined) {
      const { pendingHeal: _answered, ...rest } = existing
      saved = {
        ...rest,
        name,
        steps,
        updatedAt: now,
        rev: existing.rev + 1,
        history: nextVersion(existing, 'save', now),
      }
    } else {
      if (recipes.length >= MAX_RECIPES) {
        return { ok: false, error: `最多保存 ${MAX_RECIPES} 个流程，先删掉一个` }
      }
      saved = {
        id: `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        name,
        createdAt: now,
        updatedAt: now,
        steps,
        variables: [],
        rev: 1,
        history: [],
      }
    }
    const next = existing === undefined
      ? [...recipes, saved]
      : recipes.map(recipe => (recipe.id === saved.id ? saved : recipe))
    this.write(next)
    return { ok: true, recipe: metaOf(saved) }
  }

  remove(id: string): boolean {
    const recipes = this.read()
    const next = recipes.filter(recipe => recipe.id !== id)
    if (next.length === recipes.length) return false
    this.write(next)
    return true
  }

  /** Rename without touching the steps; the new name must stay unique. */
  rename(input: { readonly id: string; readonly name: string; readonly now?: number }): SaveResult {
    const name = input.name.replace(/\s+/gu, ' ').trim()
    if (name === '') return { ok: false, error: '流程名不能为空' }
    if (name.length > MAX_RECIPE_NAME) return { ok: false, error: `流程名最长 ${MAX_RECIPE_NAME} 个字符` }
    const recipes = this.read()
    const current = recipes.find(recipe => recipe.id === input.id)
    if (current === undefined) return { ok: false, error: '流程不存在' }
    const clash = recipes.find(recipe => recipe.id !== current.id && recipe.name.toLowerCase() === name.toLowerCase())
    if (clash !== undefined) return { ok: false, error: `已经有叫「${clash.name}」的流程` }
    const renamed: DemoRecipe = { ...current, name, updatedAt: input.now ?? Date.now() }
    this.write(recipes.map(recipe => (recipe.id === current.id ? renamed : recipe)))
    return { ok: true, recipe: metaOf(renamed) }
  }

  /**
   * Turn one fill step's literal into a `${name}` token, remembering the old
   * value as the default so the flow still runs unchanged.
   */
  parameterize(input: {
    readonly id: string
    readonly index: number
    readonly name: string
    readonly now?: number
  }): SaveResult {
    const name = input.name.trim()
    if (!VAR_NAME.test(name)) {
      return { ok: false, error: '变量名只能用字母、数字、下划线，且不能以数字开头' }
    }
    const recipes = this.read()
    const current = recipes.find(recipe => recipe.id === input.id)
    if (current === undefined) return { ok: false, error: '流程不存在' }
    const step = current.steps[input.index]
    if (step === undefined) return { ok: false, error: '步骤不存在' }
    if (step.kind !== 'fill') return { ok: false, error: '只有填写类步骤可以变成变量' }
    if (step.masked) return { ok: false, error: '密码类字段不能变成变量' }
    if (new RegExp(VAR_TOKEN.source).test(step.value)) {
      return { ok: false, error: '这一步已经是变量了' }
    }
    if (current.variables.some(variable => variable.name === name)) {
      return { ok: false, error: '变量名已存在' }
    }
    const token = '$' + '{' + name + '}'
    const steps = current.steps.map((entry, index) =>
      index === input.index && entry.kind === 'fill' ? { ...entry, value: token } : entry,
    )
    const variables = [...current.variables, { name, default: step.value.slice(0, 500) }]
    const now = input.now ?? Date.now()
    const { pendingHeal: _stale, ...rest } = current
    const next: DemoRecipe = {
      ...rest,
      steps,
      variables,
      updatedAt: now,
      rev: current.rev + 1,
      history: nextVersion(current, 'parameterize', now),
    }
    this.write(recipes.map(recipe => (recipe.id === current.id ? next : recipe)))
    return { ok: true, recipe: metaOf(next) }
  }

  /** Store a repair for the user to accept; it never touches the steps by itself. */
  recordHeal(input: { readonly id: string; readonly proposal: DemoHealProposal }): SaveResult {
    const recipes = this.read()
    const current = recipes.find(recipe => recipe.id === input.id)
    if (current === undefined) return { ok: false, error: '流程不存在' }
    const next: DemoRecipe = { ...current, pendingHeal: input.proposal }
    this.write(recipes.map(recipe => (recipe.id === current.id ? next : recipe)))
    return { ok: true, recipe: metaOf(next) }
  }

  /**
   * Accept or drop a pending repair. Accepting is the only path that rewrites
   * the flow, and it keeps the previous content one click away.
   */
  resolveHeal(input: {
    readonly id: string
    readonly accept: boolean
    readonly now?: number
  }): SaveResult {
    const now = input.now ?? Date.now()
    const recipes = this.read()
    const current = recipes.find(recipe => recipe.id === input.id)
    if (current === undefined) return { ok: false, error: '流程不存在' }
    const proposal = current.pendingHeal
    if (proposal === undefined) return { ok: false, error: '这个流程没有待确认的修复' }
    const { pendingHeal: _resolved, ...rest } = current
    if (!input.accept) {
      this.write(recipes.map(recipe => (recipe.id === current.id ? rest : recipe)))
      return { ok: true, recipe: metaOf(rest) }
    }
    const steps = sanitizeRecipeSteps(applyHealProposal(current.steps, proposal))
    const next: DemoRecipe = {
      ...rest,
      steps,
      updatedAt: now,
      rev: current.rev + 1,
      history: nextVersion(current, 'heal', now),
    }
    this.write(recipes.map(recipe => (recipe.id === current.id ? next : recipe)))
    return { ok: true, recipe: metaOf(next) }
  }

  /** Restore the newest past version; the safety net for a wrong repair. */
  rollback(input: { readonly id: string; readonly now?: number }): SaveResult {
    const now = input.now ?? Date.now()
    const recipes = this.read()
    const current = recipes.find(recipe => recipe.id === input.id)
    if (current === undefined) return { ok: false, error: '流程不存在' }
    const previous = current.history[current.history.length - 1]
    if (previous === undefined) return { ok: false, error: '没有可撤销的版本' }
    const { pendingHeal: _stale, ...rest } = current
    const next: DemoRecipe = {
      ...rest,
      steps: previous.steps,
      variables: previous.variables,
      updatedAt: now,
      rev: current.rev + 1,
      history: current.history.slice(0, -1),
    }
    this.write(recipes.map(recipe => (recipe.id === current.id ? next : recipe)))
    return { ok: true, recipe: metaOf(next) }
  }

  private revisionTick = 0

  /** Bumped on every write; the sidebar polls this instead of the whole list. */
  revision(): number {
    return this.revisionTick
  }

  private read(): DemoRecipe[] {
    if (this.filePath === null) return this.memory
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<FileShape>
      // v1 files predate revisions and repairs; read them instead of dropping
      // the user's flows on upgrade.
      if ((parsed.version !== 1 && parsed.version !== FILE_VERSION) || !Array.isArray(parsed.recipes)) return []
      return parsed.recipes
        .filter((recipe): recipe is DemoRecipe => {
          if (recipe === null || typeof recipe !== 'object') return false
          if (typeof recipe.id !== 'string' || typeof recipe.name !== 'string') return false
          return typeof recipe.createdAt === 'number' && typeof recipe.updatedAt === 'number'
        })
        .map(recipe => {
          const { pendingHeal: rawProposal, ...rest } = recipe
          const proposal = sanitizeProposal(rawProposal)
          return {
            ...rest,
            steps: sanitizeRecipeSteps(recipe.steps),
            variables: sanitizeVariables(recipe.variables),
            rev: Number.isFinite(recipe.rev) && recipe.rev > 0 ? recipe.rev : 1,
            history: sanitizeHistory(recipe.history),
            ...(proposal === undefined ? {} : { pendingHeal: proposal }),
          }
        })
        .filter(recipe => recipe.steps.length > 0)
        .slice(0, MAX_RECIPES)
    } catch {
      // Missing or corrupt file: start empty rather than lose the panel.
      return []
    }
  }

  private write(recipes: readonly DemoRecipe[]): void {
    this.revisionTick += 1
    if (this.filePath === null) {
      this.memory = [...recipes]
      return
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const shape: FileShape = { version: FILE_VERSION, recipes }
      writeFileSync(this.filePath, `${JSON.stringify(shape, null, 2)}\n`, 'utf8')
    } catch {
      // Disk failure must not take the browser panel down; the caller sees the list unchanged.
    }
  }
}
