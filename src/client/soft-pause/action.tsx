import {
  IconPauseOutlineRegular,
  IconPlayOutlineRegular,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useSyncExternalStore } from 'react'
import styles from '../styles.module.css'
import type { SoftPauseController } from './controller.ts'
import { softPauseActionVisible } from './visibility.ts'

export interface SoftPauseActionProps {
  readonly softPause: SoftPauseController
  readonly t: TranslateNS<'agent-enhancer'>
  readonly isLatestUser: boolean
  readonly isMarker: boolean
  readonly useSession: (selector: (state: { running: boolean }) => unknown) => unknown
}

/** Pause / resume control on the latest user bubble (soft gate; not official Stop). */
export function SoftPauseAction(props: SoftPauseActionProps) {
  const snapshot = useSyncExternalStore(props.softPause.subscribe, props.softPause.getSnapshot)
  const running = props.useSession(state => state.running) as boolean | undefined
  const visible = softPauseActionVisible({
    enabled: snapshot.enabled,
    isLatestUser: props.isLatestUser,
    isMarker: props.isMarker,
    running: running === true,
    engaged: snapshot.engaged,
  })
  if (!visible) return null

  const engaged = snapshot.engaged
  const label = engaged ? props.t('softPauseResume') : props.t('softPausePause')
  // Short aria-label; tooltip carries the Settings description so users see Stop ≠ soft pause.
  const tooltip = props.t('softPauseDescription')
  const busy = snapshot.busy

  // Product Tooltip only — native `title` showed a second (browser) tip on hover.
  return <Tooltip label={tooltip} side="bottom">
    <button
      type="button"
      className={styles.userMessageAction}
      aria-label={label}
      disabled={busy}
      data-action={engaged ? 'soft-pause-resume' : 'soft-pause-pause'}
      data-engaged={engaged || undefined}
      onClick={() => { void props.softPause.toggle() }}
    >
      {engaged ? <IconPlayOutlineRegular /> : <IconPauseOutlineRegular />}
    </button>
  </Tooltip>
}
