export interface SessionDeleteRequest {
  readonly sessionId: string
  readonly displayTitle: string
  readonly workspaceId?: string
  readonly wasOpen: boolean
}

let pending: SessionDeleteRequest | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function requestSessionDelete(request: SessionDeleteRequest): void {
  pending = request
  notify()
}

export function settleSessionDeleteRequest(): void {
  pending = null
  notify()
}

export function getPendingSessionDelete(): SessionDeleteRequest | null {
  return pending
}

export function subscribeSessionDelete(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
