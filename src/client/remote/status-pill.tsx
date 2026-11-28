import { useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteChannelIdWire, RemoteStatusWire } from '../../host/rpc.ts'
import type { SettingsPersistOp } from '../dsh/persist-settings.ts'
import { agentEnhancerRemoteSetChannelEnabled, agentEnhancerRemoteStatus } from '../remote.ts'
import styles from '../styles.module.css'

export interface RemoteStatusPillProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly getRemote?: () => unknown
  readonly isEnabled: () => boolean
  readonly persist: (ops: readonly SettingsPersistOp[]) => Promise<void>
}

const POLL_MS = 4_000
const CHANNELS: readonly { readonly id: RemoteChannelIdWire; readonly label: 'remoteChannelWeixin' | 'remoteChannelTelegram' | 'remoteChannelFeishu' }[] = [
  { id: 'weixin', label: 'remoteChannelWeixin' },
  { id: 'telegram', label: 'remoteChannelTelegram' },
  { id: 'feishu', label: 'remoteChannelFeishu' },
]

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/**
 * Frame-wide one-click remote switch. The master click toggles the same
 * `remoteControlEnabled` config as Settings; the caret opens a small menu for
 * pausing individual channels without clearing their credentials or bindings.
 */
export function RemoteStatusPill(props: RemoteStatusPillProps) {
  const [status, setStatus] = useState<RemoteStatusWire | null>(null)
  const [enabled, setEnabled] = useState(props.isEnabled())
  const [busy, setBusy] = useState(false)
  const [busyChannel, setBusyChannel] = useState<RemoteChannelIdWire | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async (): Promise<void> => {
      const remote = props.getRemote?.()
      if (remote !== undefined) {
        try {
          const next = await agentEnhancerRemoteStatus.invoke(remote)
          if (active) setStatus(next)
        } catch {
          // Keep the last known state; the next tick retries.
        }
      }
    }
    const tick = async (): Promise<void> => {
      await refresh()
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

  const toggleMaster = (): void => {
    if (busy) return
    setBusy(true)
    void props.persist([{ op: 'set', path: ['remoteControlEnabled'], value: !enabled }])
      .then(() => {
        setEnabled(!enabled)
        setOpen(false)
      })
      .catch(() => { setEnabled(props.isEnabled()) })
      .finally(() => { setBusy(false) })
  }

  const toggleChannel = (id: RemoteChannelIdWire, next: boolean): void => {
    const remote = props.getRemote?.()
    if (remote === undefined || busyChannel !== null) return
    setBusyChannel(id)
    void (async () => {
      try {
        if (!enabled && next) {
          // A paused channel cannot be started while the whole feature is off:
          // turn the master switch on first, then wait for the host hub to boot.
          await props.persist([{ op: 'set', path: ['remoteControlEnabled'], value: true }])
          setEnabled(true)
          let started = false
          for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
            const result = await agentEnhancerRemoteSetChannelEnabled.invoke(remote, { channel: id, enabled: true })
            started = result.ok
            if (!started) await new Promise(resolve => { setTimeout(resolve, 200) })
          }
        } else {
          await agentEnhancerRemoteSetChannelEnabled.invoke(remote, { channel: id, enabled: next })
        }
        setStatus(await agentEnhancerRemoteStatus.invoke(remote))
      } catch {
        // Leave the previous state visible; the poll will reconcile it.
      } finally {
        setBusyChannel(null)
      }
    })()
  }

  const running = status?.channels.filter(channel => channel.phase === 'running' && channel.enabled !== false).length ?? 0
  const devices = status?.channels.reduce((total, channel) => total + channel.devices.length, 0) ?? 0
  const label = busy
    ? props.t('remotePillBusy')
    : !enabled
      ? props.t('remotePillOff')
      : running > 0
        ? props.t('remotePillOn')
        : props.t('remotePillNoChannel')
  const tooltip = enabled
    ? fill(props.t('remotePillTooltipOn'), { channels: String(running), devices: String(devices) })
    : props.t('remotePillTooltipOff')

  return (
    <div className={styles.remotePillWrap}>
      <div className={styles.remotePillRow}>
        <button
          type="button"
          className={styles.remotePill}
          data-on={enabled ? 'true' : 'false'}
          disabled={busy}
          title={tooltip}
          aria-label={tooltip}
          aria-pressed={enabled}
          onClick={toggleMaster}
        >
          <span className={styles.remotePillDot} aria-hidden="true" />
          <span>{label}</span>
          {enabled && running > 0 ? <span className={styles.remotePillCount}>{running}</span> : null}
        </button>
        <button
          type="button"
          className={styles.remotePillCaret}
          title={props.t('remotePillOpenMenu')}
          aria-label={props.t('remotePillOpenMenu')}
          aria-expanded={open}
          disabled={busy}
          onClick={() => { setOpen(current => !current) }}
        >
          ▾
        </button>
      </div>
      {open ? (
        <div className={styles.remotePillMenu} role="group" aria-label={props.t('remotePillChannelsTitle')}>
          <span className={styles.remotePillMenuTitle}>{props.t('remotePillChannelsTitle')}</span>
          <span className={styles.remotePillMenuHint}>
            {enabled ? props.t('remotePillMenuHint') : props.t('remotePillMenuOffHint')}
          </span>
          {CHANNELS.map(channel => {
            const row = status?.channels.find(entry => entry.id === channel.id)
            const on = enabled && row?.phase === 'running' && row.enabled !== false
            return (
              <button
                key={channel.id}
                type="button"
                className={styles.remotePillChannel}
                data-on={on ? 'true' : 'false'}
                disabled={busyChannel === channel.id}
                onClick={() => { toggleChannel(channel.id, !on) }}
              >
                <span className={styles.remotePillDot} aria-hidden="true" />
                <span>{props.t(channel.label)}</span>
                <span className={styles.remotePillChannelState}>
                  {on ? props.t('remoteChannelPhase_running') : props.t('remoteChannelPhase_paused')}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
