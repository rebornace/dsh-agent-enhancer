import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { useMemo } from 'react'
import styles from '../styles.module.css'
import type { RollbackController } from './controller.ts'
import { rollbackInputActionsFor } from './input-actions-cache.ts'
import { RollbackModalHost } from './modal-host.tsx'
import type { RollbackRemote } from './types.ts'
import type { CheckpointTimelineTabParams } from './timeline-kind.ts'
import { CheckpointTimelinePanel } from './timeline-panel.tsx'
import { activityStatsFromEntries } from './transcript.ts'

interface SessionStatsProjection {
  get(key: string): unknown
  faceOf(key: string): { subscribe(listener: () => void): () => void }
}

interface SessionBinding {
  readonly eventSource: {
    getSnapshot(): { entries: readonly unknown[] }
    subscribe(listener: () => void): () => void
  }
  readonly session: { readonly projections: SessionStatsProjection }
}

interface SessionsLookup {
  binding(id: SessionId): SessionBinding | undefined
}

function chatActivityOf(sessions: SessionsLookup | undefined, sessionId: SessionId): {
  readonly turns: number
  readonly steps: number
} | undefined {
  const binding = sessions?.binding(sessionId)
  if (binding?.eventSource?.getSnapshot === undefined) return undefined
  try {
    const entries = binding.eventSource.getSnapshot().entries
    // Same fold as the composer ActivityPill / transcript filter — never Host whole-log.
    return activityStatsFromEntries(entries as never)
  } catch {
    return undefined
  }
}

function subscribeChatActivityOf(
  sessions: SessionsLookup | undefined,
  sessionId: SessionId,
  listener: () => void,
): () => void {
  const binding = sessions?.binding(sessionId)
  if (binding === undefined) return () => {}
  const disposers: Array<() => void> = []
  try {
    disposers.push(binding.eventSource.subscribe(listener))
  } catch {
    // eventSource may be unavailable while the right pane mounts without a live chat.
  }
  try {
    const face = binding.session.projections.faceOf('sessionStats')
    if (typeof face?.subscribe === 'function') disposers.push(face.subscribe(listener))
  } catch {
    // sessionStats face is optional for the timeline lead line.
  }
  return () => {
    while (disposers.length > 0) disposers.pop()?.()
  }
}

export interface CheckpointTimelineTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly remote: RollbackRemote
  readonly locale?: string
  readonly sessions?: SessionsLookup
  readonly rollbackFor: (sessionId: SessionId) => RollbackController
  readonly onRestore: (sessionId: SessionId, turn: number) => void
  readonly onUndo: (sessionId: SessionId, turn: number) => void
}

function paramsOf(raw: unknown): Partial<CheckpointTimelineTabParams> {
  if (typeof raw !== 'object' || raw === null) return {}
  const record = raw as Record<string, unknown>
  return {
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId as SessionId } : {}),
    ...(typeof record.turn === 'number' ? { turn: record.turn } : {}),
  }
}

function CheckpointTimelineTabBody(props: CheckpointTimelineTabProps & {
  readonly sessionId: SessionId
  readonly focusTurn?: number
}) {
  const rollback = props.rollbackFor(props.sessionId)
  const activityBridge = useMemo(() => {
    const sessions = props.sessions
    if (sessions === undefined) return {}
    const sessionId = props.sessionId
    return {
      readChatActivity: () => chatActivityOf(sessions, sessionId),
      subscribeChatActivity: (listener: () => void) => (
        subscribeChatActivityOf(sessions, sessionId, listener)
      ),
    }
  }, [props.sessions, props.sessionId])

  return <div className={styles.timelineRightPane}>
    <CheckpointTimelinePanel
      sessionId={props.sessionId}
      focusTurn={props.focusTurn}
      remote={props.remote}
      rollback={rollback}
      t={props.t}
      locale={props.locale}
      {...activityBridge}
      onRestore={turn => { props.onRestore(props.sessionId, turn) }}
      onUndo={turn => { props.onUndo(props.sessionId, turn) }}
    />
    {/* Own the confirm modal for timeline opens — composer overlay may not be
        subscribed/visible while the right pane has focus. */}
    <RollbackModalHost
      rollback={rollback}
      t={props.t}
      inputActions={rollbackInputActionsFor(props.sessionId)}
      sessionId={props.sessionId}
      surface="timeline"
    />
  </div>
}

export function CheckpointTimelineTab(props: CheckpointTimelineTabProps) {
  const info = props.useTabInfo()
  const params = paramsOf(info.tab.navigation.params)
  if (params.sessionId === undefined) {
    return <div className={styles.timelineRightPane}>
      <p className={styles.timelineStatus}>{props.t('rollbackTimelineNoSession')}</p>
    </div>
  }
  return <CheckpointTimelineTabBody
    {...props}
    sessionId={params.sessionId}
    focusTurn={params.turn}
  />
}

export function CheckpointTimelineTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  return <span>{props.t('rollbackTimelineTitle')}</span>
}
