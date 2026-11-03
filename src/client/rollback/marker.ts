import { isRollbackId, turnFromRollbackId } from '../../identity.ts'

export function isRollbackMarkerSource(source: unknown): boolean {
  return (source as { kind?: string } | null)?.kind === 'checkpoint-rollback'
}

export function isRollbackMarkerMessage(source: unknown, id: string | undefined): boolean {
  return isRollbackMarkerSource(source) || (id !== undefined && isRollbackId(id))
}

export function turnFromRollbackMarkerId(id: string | undefined): number | undefined {
  if (id === undefined) return undefined
  return turnFromRollbackId(id)
}
