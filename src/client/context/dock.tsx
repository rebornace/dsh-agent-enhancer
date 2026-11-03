import { useEffect } from 'react'
import type { TranslateNS, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ContextInspectCategory } from '../../host/context-inspect.ts'
import { installContextMeterEnhance } from './enhance-meter.ts'

export interface ContextInspectDockProps extends PropsRuntime<'conversation.composer.dock'> {
  readonly enabled: () => boolean
  readonly open: (category: ContextInspectCategory) => void
  readonly t: TranslateNS<'agent-enhancer'>
}

/** Invisible dock resident: wires drill-down onto the official context meter. */
export function ContextInspectDock(props: ContextInspectDockProps) {
  const sessionId = props.sessionId as SessionId | undefined
  useEffect(() => installContextMeterEnhance({
    enabled: props.enabled,
    sessionId: () => sessionId,
    open: props.open,
    t: (key, params) => props.t(key as never, params as never),
  }), [sessionId, props.enabled, props.open, props.t])
  return null
}
