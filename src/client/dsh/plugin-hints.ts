import { MODULES } from '../../config.ts'
import type { ModuleName } from '../../config.ts'

export const KNOWN_OVERLAPS = {
  history: ['dsh-composer-history', 'dsh-prompt-history', 'dsh-input-assistant'],
  optimize: ['dsh-input-assistant'],
  predict: ['dsh-reply-suggestions', 'dsh-prompt-history', 'dsh-input-assistant'],
} as const

export function overlapHints(entries: readonly { moduleName: string; enabled: boolean }[]): ModuleName[] {
  return MODULES.filter(module => KNOWN_OVERLAPS[module].some(name =>
    entries.some(entry => entry.enabled && entry.moduleName === name)))
}

type HintStorage = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): HintStorage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

export class OverlapHintStore {
  private hints: readonly ModuleName[] = []
  private active = true
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly storage: HintStorage | undefined = browserStorage(),
    private readonly version = '0.1.0',
  ) {}

  getSnapshot(): readonly ModuleName[] {
    return this.hints
  }

  subscribe(listener: () => void): () => void {
    if (!this.active) return () => {}
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  accept(entries: readonly { moduleName: string; enabled: boolean }[]): void {
    if (!this.active) return
    const arrived = overlapHints(entries).filter(module =>
      !this.hints.includes(module) && !this.dismissed(module))
    if (arrived.length === 0) return
    for (const module of arrived) this.remember(module)
    this.hints = [...this.hints, ...arrived]
    this.emit()
  }

  dismiss(module: ModuleName): void {
    if (!this.active) return
    this.remember(module)
    if (!this.hints.includes(module)) return
    this.hints = this.hints.filter(candidate => candidate !== module)
    this.emit()
  }

  dispose(): void {
    this.active = false
    this.listeners.clear()
  }

  private key(module: ModuleName): string {
    return `dsh-composer-enhancer:overlap-hint:${this.version}:${module}`
  }

  private dismissed(module: ModuleName): boolean {
    try {
      return this.storage?.getItem(this.key(module)) === '1'
    } catch {
      return false
    }
  }

  private remember(module: ModuleName): void {
    try {
      this.storage?.setItem(this.key(module), '1')
    } catch {}
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
