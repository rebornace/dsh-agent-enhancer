import { isRollbackMarkerMessage } from '../rollback/marker.ts'

export interface SoftPauseVisibilityInput {
  readonly enabled: boolean
  readonly isLatestUser: boolean
  readonly isMarker: boolean
  readonly running: boolean
  readonly engaged: boolean
  /**
   * Live work elsewhere in this session's tree (a subagent that outlived the
   * turn). The parent hands off in seconds, so the turn flag alone would hide
   * the only control that can stop the child.
   */
  readonly treeRunning: boolean
}

/** Icon shows only on the latest non-marker user bubble while this tree has work. */
export function softPauseActionVisible(input: SoftPauseVisibilityInput): boolean {
  if (!input.enabled || input.isMarker || !input.isLatestUser) return false
  return input.running || input.engaged || input.treeRunning
}

type ChatSnapshotLike = {
  readonly order: readonly string[]
  readonly nodes: { get(key: string): { readonly kind: string; readonly data: unknown } | undefined }
}

/** Last direct user prompt in chat order (skips markers / injects). */
export function isLatestNonMarkerUserMessage(
  chat: ChatSnapshotLike | undefined,
  nodeKey: string,
  messageId: string | undefined,
  source: unknown,
): boolean {
  if (chat === undefined || chat.nodes === undefined) return false
  if (isRollbackMarkerMessage(source, messageId)) return false
  for (let index = chat.order.length - 1; index >= 0; index -= 1) {
    const key = chat.order[index]!
    const candidate = chat.nodes.get(key)
    if (candidate?.kind !== 'user') continue
    const data = candidate.data as { readonly id?: string; readonly source?: unknown }
    if (isRollbackMarkerMessage(data.source, data.id)) continue
    const kind = (data.source as { kind?: string } | undefined)?.kind
    if (kind !== undefined && kind !== 'user') continue
    return key === nodeKey
  }
  return false
}
