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

export interface DemoRecipe {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly steps: readonly DemoStep[]
}

/** List entry: steps are counted, never sent, so the panel stays light. */
export interface DemoRecipeMeta {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly steps: number
}

export const MAX_RECIPES = 20
export const MAX_RECIPE_NAME = 60
export const MAX_RECIPE_STEPS = 200
const FILE_VERSION = 1

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
      saved = { ...existing, name, steps, updatedAt: now }
    } else {
      if (recipes.length >= MAX_RECIPES) {
        return { ok: false, error: `最多保存 ${MAX_RECIPES} 个流程，先删掉一个` }
      }
      saved = { id: `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, createdAt: now, updatedAt: now, steps }
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

  private read(): DemoRecipe[] {
    if (this.filePath === null) return this.memory
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<FileShape>
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.recipes)) return []
      return parsed.recipes
        .filter((recipe): recipe is DemoRecipe => {
          if (recipe === null || typeof recipe !== 'object') return false
          if (typeof recipe.id !== 'string' || typeof recipe.name !== 'string') return false
          return typeof recipe.createdAt === 'number' && typeof recipe.updatedAt === 'number'
        })
        .map(recipe => ({ ...recipe, steps: sanitizeRecipeSteps(recipe.steps) }))
        .filter(recipe => recipe.steps.length > 0)
        .slice(0, MAX_RECIPES)
    } catch {
      // Missing or corrupt file: start empty rather than lose the panel.
      return []
    }
  }

  private write(recipes: readonly DemoRecipe[]): void {
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
