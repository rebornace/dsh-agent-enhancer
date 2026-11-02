const ROLLBACK_PREFIX = 'dsh-composer-enhancer:rollback:'

export function isRollbackMarkerSource(source: unknown): boolean {
  return (source as { kind?: string } | null)?.kind === 'checkpoint-rollback'
}

export function isRollbackMarkerMessage(source: unknown, id: string | undefined): boolean {
  return isRollbackMarkerSource(source) || (id?.startsWith(ROLLBACK_PREFIX) ?? false)
}

export function turnFromRollbackMarkerId(id: string | undefined): number | undefined {
  if (id === undefined) return undefined
  const match = new RegExp(`^${ROLLBACK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+):`).exec(id)
  return match === null ? undefined : Number(match[1])
}
