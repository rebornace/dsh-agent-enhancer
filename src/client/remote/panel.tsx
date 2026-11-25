import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import type { RemoteStatusWire } from '../../host/rpc.ts'
import styles from '../styles.module.css'
import {
  agentEnhancerRemoteBindCode,
  agentEnhancerRemoteLoginBegin,
  agentEnhancerRemoteLoginCancel,
  agentEnhancerRemoteLogout,
  agentEnhancerRemoteRevoke,
  agentEnhancerRemoteStatus,
} from '../remote.ts'
import { QrCode } from './qr-code.tsx'

export interface RemoteControlPanelProps {
  readonly t: TranslateNS<'agent-enhancer'>
  /** Host remote face; undefined in a preview without Host wiring. */
  readonly getRemote?: () => unknown
  readonly busy: boolean
}

const POLL_MS = 3_000

function shortChatId(chatId: string): string {
  if (chatId.length <= 12) return chatId
  return `${chatId.slice(0, 6)}…${chatId.slice(-4)}`
}

/**
 * Settings card for the WeChat channel: connect, pair a chat, see devices.
 *
 * Status is polled from the host because the scan confirms out of band; the
 * page never holds the bot token, only the status object the host builds.
 */
export function RemoteControlPanel({ t, getRemote, busy }: RemoteControlPanelProps) {
  const [status, setStatus] = useState<RemoteStatusWire | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [bindCode, setBindCode] = useState<string | null>(null)
  const remoteRef = useRef(getRemote)
  remoteRef.current = getRemote

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async (): Promise<void> => {
      const remote = remoteRef.current?.()
      if (remote === undefined) {
        if (active) setLoadError(t('remoteLoadFailed'))
        return
      }
      try {
        const next = await agentEnhancerRemoteStatus.invoke(remote)
        if (!active) return
        setStatus(next)
        setLoadError(null)
      } catch (error) {
        if (!active) return
        setLoadError(error instanceof Error ? error.message : String(error))
      }
      if (active) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
    // The panel mounts only while the feature is on; polling lives for that span.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refresh = async (): Promise<void> => {
    const remote = remoteRef.current?.()
    if (remote === undefined) return
    const next = await agentEnhancerRemoteStatus.invoke(remote)
    setStatus(next)
  }

  const run = async (key: string, action: (remote: unknown) => Promise<{ ok?: boolean; error?: string } | void>): Promise<void> => {
    const remote = remoteRef.current?.()
    if (remote === undefined) return
    setPending(key)
    setActionError(null)
    try {
      const result = await action(remote)
      if (result !== undefined && result.ok === false) {
        setActionError(result.error ?? t('remoteFailed'))
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPending(null)
      await refresh().catch(() => {})
    }
  }

  const phase = status?.phase ?? 'stopped'
  const login = status?.login
  const connected = phase === 'running'
  const qrUrl = login?.qrUrl
  const waitingForScan = login?.phase === 'waiting' && qrUrl !== undefined
  const devices = status?.devices ?? []
  const disabled = busy || pending !== null || getRemote === undefined

  return (
    <div className={styles.remotePanel} data-remote-panel>
      <div className={styles.remoteHeader}>
        <span className={styles.remotePhase}>
          {t(`remoteStatus_${phase}` as 'remoteStatus_stopped')}
        </span>
        {connected ? (
          <button
            type="button"
            className={styles.settingsLink}
            disabled={disabled}
            onClick={() => {
              setBindCode(null)
              void run('logout', remote => agentEnhancerRemoteLogout.invoke(remote))
            }}
          >
            {t('remoteLogout')}
          </button>
        ) : null}
      </div>

      {loadError !== null ? <p className={styles.remoteError} role="status">{loadError}</p> : null}
      {actionError !== null ? <p className={styles.remoteError} role="alert">{actionError}</p> : null}
      {phase === 'failed' && status?.error !== undefined ? (
        <p className={styles.remoteError} role="alert">{status.error}</p>
      ) : null}

      {waitingForScan && qrUrl !== undefined ? (
        <div className={styles.remoteQr}>
          <QrCode value={qrUrl} label={t('remoteQrLabel')} />
          <p className={styles.remoteHint}>{t('remoteLoginHint')}</p>
          <p className={styles.remoteHint}>{t('remoteLoginWaiting')}</p>
          <div className={styles.remoteActions}>
            <button
              type="button"
              className={styles.settingsLink}
              disabled={disabled}
              onClick={() => { void run('cancel', remote => agentEnhancerRemoteLoginCancel.invoke(remote)) }}
            >
              {t('remoteLoginCancel')}
            </button>
            <button
              type="button"
              className={styles.settingsLink}
              disabled={disabled}
              onClick={() => { void run('login', remote => agentEnhancerRemoteLoginBegin.invoke(remote)) }}
            >
              {t('remoteRegenerate')}
            </button>
          </div>
        </div>
      ) : connected ? null : (
        <div className={styles.remoteActions}>
          <button
            type="button"
            className={styles.settingsActionPrimary}
            disabled={disabled}
            onClick={() => { void run('login', remote => agentEnhancerRemoteLoginBegin.invoke(remote)) }}
          >
            {t('remoteLogin')}
          </button>
          {login?.phase === 'failed' ? (
            <span className={styles.remoteHint}>
              {login.status === 'expired' ? t('remoteLoginExpired') : t('remoteLoginFailed')}
            </span>
          ) : null}
        </div>
      )}

      {connected ? (
        <>
          <div className={styles.remoteActions}>
            <button
              type="button"
              className={styles.settingsLink}
              disabled={disabled}
              onClick={() => {
                setBindCode(null)
                void run('bind', async remote => {
                  const result = await agentEnhancerRemoteBindCode.invoke(remote)
                  if (result.ok && result.code !== undefined) setBindCode(result.code)
                  return result
                })
              }}
            >
              {t('remoteBindCode')}
            </button>
            <button
              type="button"
              className={styles.settingsLink}
              disabled={disabled}
              onClick={() => { void run('login', remote => agentEnhancerRemoteLoginBegin.invoke(remote)) }}
            >
              {t('remoteLoginAgain')}
            </button>
          </div>
          {bindCode !== null ? (
            <div className={styles.remoteBind}>
              <span className={styles.remoteCode}>{bindCode}</span>
              <p className={styles.remoteHint}>{t('remoteBindCodeHint')}</p>
              <p className={styles.remoteHint}>{t('remoteBindCodeExpires')}</p>
            </div>
          ) : null}
        </>
      ) : null}

      <div className={styles.remoteDevicesBlock}>
        <p className={styles.remoteHint}>{t('remoteDevices')}</p>
        {devices.length === 0 ? (
          <p className={styles.remoteHint}>{t('remoteDevicesEmpty')}</p>
        ) : (
          <ul className={styles.remoteDevices}>
            {devices.map(device => (
              <li key={device.chatId} className={styles.remoteDevice}>
                <span title={device.chatId}>{shortChatId(device.chatId)}</span>
                <span className={styles.remoteHint}>
                  {new Date(device.boundAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className={styles.settingsLink}
                  disabled={disabled}
                  onClick={() => {
                    void run('revoke', remote => agentEnhancerRemoteRevoke.invoke(remote, { chatId: device.chatId }))
                  }}
                >
                  {t('remoteRevoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {connected ? (
        <p className={styles.remoteHint}>
          {t('remoteTasksSynced')}: {status?.tasks ?? 0}
        </p>
      ) : null}
    </div>
  )
}
