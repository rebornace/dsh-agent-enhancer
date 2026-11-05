import { useEffect } from 'react'
import type { TranslateNS, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { installSessionStatsCheckpointLink } from './session-stats-meter.ts'

export interface SessionStatsCheckpointDockProps extends PropsRuntime<'conversation.composer.dock'> {
  readonly enabled: () => boolean
  readonly open: (sessionId: SessionId) => void
  readonly t: TranslateNS<'agent-enhancer'>
}

/** Invisible dock resident: weak optional jump on the official 会话统计 title. */
export function SessionStatsCheckpointDock(props: SessionStatsCheckpointDockProps) {
  const sessionId = props.sessionId as SessionId | undefined
  useEffect(() => installSessionStatsCheckpointLink({
    enabled: props.enabled,
    sessionId: () => sessionId,
    open: () => {
      if (sessionId === undefined) return
      props.open(sessionId)
    },
    label: () => props.t('rollbackTimelineOpen'),
  }), [sessionId, props.enabled, props.open, props.t])
  return null
}
