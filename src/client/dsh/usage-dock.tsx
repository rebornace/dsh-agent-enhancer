import { useEffect } from 'react'
import type { TranslateNS, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { installUsageMeterLink } from './usage-meter.ts'

export interface UsageMeterDockProps extends PropsRuntime<'conversation.composer.dock'> {
  readonly open: () => void
  readonly t: TranslateNS<'agent-enhancer'>
}

/** Invisible dock resident: adds a bill jump to the official Token Usage dialog. */
export function UsageMeterDock(props: UsageMeterDockProps) {
  useEffect(() => installUsageMeterLink({
    open: props.open,
    label: () => props.t('usageMeterOpen'),
  }), [props.open, props.t])
  return null
}
