import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteStatusWire } from '../../host/rpc.ts'
import type { SettingsPersistOp } from '../dsh/persist-settings.ts'
import { agentEnhancerRemoteStatus } from '../remote.ts'
import styles from '../styles.module.css'

export interface RemoteStatusPillProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly getRemote?: () => unknown
  readonly isEnabled: () => boolean
  readonly persist: (ops: readonly SettingsPersistOp[]) => Promise<void>
}

const POLL_MS = 4_000

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/**
 * Frame-wide one-click remote switch. The feature toggle still lives in
 * Settings; this is only a shortcut plus a live glance at how many channels and
 * chats are actually connected, so nobody has to open Settings just to check.
 */
export function RemoteStatusPill(props: RemoteStatusPillProps) {
  const [status, setStatus] = useState<RemoteStatusWire | null>(null)
  const [enabled, setEnabled] = useState(props.isEnabled())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      const remote = props.getRemote?.()
      if (remote !== undefined) {
        try {
          const next = await agentEnhancerRemoteStatus.invoke(remote)
          if (active) setStatus(next)
        } catch {
          // The pill keeps its last known state; the next tick retries.
        }
      }
      if (active) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    const sync = (): void => { setEnabled(props.isEnabled()) }
    const unsubscribe = setInterval(sync, 2_000)
    return () => {
      active = false
      clearInterval(unsubscribe)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [props.getRemote])

  const toggle = (): void => {
    if (busy) return
    setBusy(true)
    void props.persist([{ op: 'set', path: ['remoteControlEnabled'], value: !enabled }])
      .then(() => { setEnabled(!enabled) })
      .catch(() => { setEnabled(props.isEnabled()) })
      .finally(() => { setBusy(false) })
  }

  const running = status?.channels.filter(channel => channel.phase === 'running').length ?? 0
  const devices = status?.channels.reduce((total, channel) => total + channel.devices.length, 0) ?? 0
  const label = busy
    ? props.t('remotePillBusy')
    : !enabled
      ? props.t('remotePillOff')
      : running > 0
        ? props.t('remotePillOn')
        : props.t('remotePillNoChannel')
  const tooltip = enabled
    ? fill(props.t('remotePillTooltipOn'), {
      channels: String(running),
      devices: String(devices),
    })
    : props.t('remotePillTooltipOff')

  return (
    <button
      type="button"
      className={styles.remotePill}
      data-on={enabled ? 'true' : 'false'}
      disabled={busy}
      title={tooltip}
      aria-label={tooltip}
      aria-pressed={enabled}
      onClick={toggle}
    >
      <span className={styles.remotePillDot} aria-hidden="true" />
      <span>{label}</span>
      {enabled && running > 0 ? (
        <span className={styles.remotePillCount}>{running}</span>
      ) : null}
    </button>
  )
}
