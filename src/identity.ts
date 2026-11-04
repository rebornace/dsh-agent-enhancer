/** Canonical package / plugin identity after the Composer → Agent rename. */
export const PACKAGE_NAME = 'dsh-agent-enhancer'
export const PLUGIN_ID = 'agent-enhancer'
export const PACKAGE_VERSION = '0.3.1'

/** Pre-0.2.0 identity — keep reading markers and plugin-data written under these names. */
export const LEGACY_PACKAGE_NAME = 'dsh-composer-enhancer'
export const LEGACY_PLUGIN_ID = 'composer-enhancer'

export const ROLLBACK_PREFIX = `${PACKAGE_NAME}:rollback:`
export const UNDO_PREFIX = `${PACKAGE_NAME}:undo:`
export const LEGACY_ROLLBACK_PREFIX = `${LEGACY_PACKAGE_NAME}:rollback:`
export const LEGACY_UNDO_PREFIX = `${LEGACY_PACKAGE_NAME}:undo:`

export function isRollbackId(id: string): boolean {
  return id.startsWith(ROLLBACK_PREFIX) || id.startsWith(LEGACY_ROLLBACK_PREFIX)
}

export function isUndoId(id: string): boolean {
  return id.startsWith(UNDO_PREFIX) || id.startsWith(LEGACY_UNDO_PREFIX)
}

export function indexOfRollbackPrefix(id: string): number {
  const current = id.indexOf(ROLLBACK_PREFIX)
  if (current >= 0) return current
  return id.indexOf(LEGACY_ROLLBACK_PREFIX)
}

export function rollbackPrefixAt(id: string, index: number): string | undefined {
  if (id.startsWith(ROLLBACK_PREFIX, index)) return ROLLBACK_PREFIX
  if (id.startsWith(LEGACY_ROLLBACK_PREFIX, index)) return LEGACY_ROLLBACK_PREFIX
  return undefined
}

export function turnFromRollbackId(id: string): number | undefined {
  for (const prefix of [ROLLBACK_PREFIX, LEGACY_ROLLBACK_PREFIX]) {
    if (!id.startsWith(prefix)) continue
    const match = new RegExp(`^${escapeRegExp(prefix)}(\\d+):`).exec(id)
    if (match !== null) return Number(match[1])
  }
  // Undo copies embed the original marker id after the copy prefix
  // (`…:undo:…:{seq}:…:rollback:{turn}:…`). Parse the embedded tip turn.
  const embedded = indexOfRollbackPrefix(id)
  if (embedded > 0) return turnFromRollbackId(id.slice(embedded))
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
