import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import type { RemoteChannelIdWire, RemoteChannelStatusWire, RemoteStatusWire } from '../../host/rpc.ts'
import styles from '../styles.module.css'
import {
  agentEnhancerRemoteBindCode,
  agentEnhancerRemoteLoginBegin,
  agentEnhancerRemoteLoginCancel,
  agentEnhancerRemoteLogout,
  agentEnhancerRemoteRevoke,
  agentEnhancerRemoteStatus,
  agentEnhancerRemoteTelegramConnect,
} from '../remote.ts'
import { QrCode } from './qr-code.tsx'

export interface RemoteSettingsPanelProps {
  readonly t: TranslateNS<'agent-enhancer'>
  /** Host remote face; undefined in a preview without Host wiring. */
  readonly getRemote?: () => unknown
  readonly busy: boolean
  /** Master switch lives on the Features tab. */
  readonly enabled: boolean
  readonly onOpenFeatures: () => void
}

const POLL_MS = 3_000

function shortChatId(chatId: string): string {
  if (chatId.length <= 12) return chatId
  return `${chatId.slice(0, 6)}…${chatId.slice(-4)}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Remote channels settings: one card per platform.
 *
 * Status is polled from the host because scans and token checks happen out of
 * band. Approval decisions never happen here; this page only connects channels
 * and pairs chats.
 */
export function RemoteSettingsPanel({ t, getRemote, busy, enabled, onOpenFeatures }: RemoteSettingsPanelProps) {
  const [status, setStatus] = useState<RemoteStatusWire | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [codes, setCodes] = useState<Partial<Record<RemoteChannelIdWire, string>>>({})
  const [token, setToken] = useState('')
  const [showBotFather, setShowBotFather] = useState(false)
  const remoteRef = useRef(getRemote)
  remoteRef.current = getRemote

  useEffect(() => {
    if (!enabled) return
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
        setLoadError(errorMessage(error))
      }
      if (active) timer = setTimeout(() => { void tick() }, POLL_MS)
    }
    void tick()
    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
    // The tab mounts only while Settings is open; polling lives for that span.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  const refresh = async (): Promise<void> => {
    const remote = remoteRef.current?.()
    if (remote === undefined) return
    setStatus(await agentEnhancerRemoteStatus.invoke(remote))
  }

  const run = async (
    key: string,
    action: (remote: unknown) => Promise<{ ok?: boolean; error?: string } | void>,
  ): Promise<void> => {
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
      setActionError(errorMessage(error))
    } finally {
      setPending(null)
      await refresh().catch(() => {})
    }
  }

  const disabled = busy || pending !== null || getRemote === undefined || !enabled
  const weixin = status?.channels.find(channel => channel.id === 'weixin')
  const telegram = status?.channels.find(channel => channel.id === 'telegram')

  const issueCode = (channel: RemoteChannelIdWire): void => {
    void run(`bind-${channel}`, async remote => {
      const result = await agentEnhancerRemoteBindCode.invoke(remote, { channel })
      if (result.ok && result.code !== undefined) {
        setCodes(current => ({ ...current, [channel]: result.code }))
      }
      return result
    })
  }

  const revoke = (channel: RemoteChannelIdWire, chatId: string): void => {
    void run(`revoke-${channel}`, remote => agentEnhancerRemoteRevoke.invoke(remote, { channel, chatId }))
  }

  const logout = (channel: RemoteChannelIdWire): void => {
    setCodes(current => ({ ...current, [channel]: undefined }))
    void run(`logout-${channel}`, remote => agentEnhancerRemoteLogout.invoke(remote, { channel }))
  }

  return (
    <div className={styles.remoteSettings}>
      <div className={styles.remoteSettingsHeader}>
        <p className={styles.remoteIntro}>{t('remoteSettingsIntro')}</p>
        <span className={styles.remoteHint}>
          {t('remoteTasksSynced')}: {status?.tasks ?? 0}
        </span>
      </div>

      {loadError !== null ? <p className={styles.remoteError} role="status">{loadError}</p> : null}
      {actionError !== null ? <p className={styles.remoteError} role="alert">{actionError}</p> : null}

      {!enabled ? (
        <div className={styles.remoteDisabled} role="note">
          <p className={styles.remoteHint}>{t('remoteDisabledHint')}</p>
          <button
            type="button"
            className={styles.settingsActionPrimary}
            disabled={busy}
            onClick={onOpenFeatures}
          >
            {t('remoteOpenFeatures')}
          </button>
        </div>
      ) : null}

      {enabled ? (
        <>
          <ChannelCard
        t={t}
        channel={weixin}
        id="weixin"
        title={t('remoteChannelWeixin')}
        code={codes.weixin}
        disabled={disabled}
        onLogin={() => { void run('weixin-login', remote => agentEnhancerRemoteLoginBegin.invoke(remote)) }}
        onCancel={() => { void run('weixin-cancel', remote => agentEnhancerRemoteLoginCancel.invoke(remote)) }}
        onBindCode={() => { issueCode('weixin') }}
        onLogout={() => { logout('weixin') }}
        onRevoke={chatId => { revoke('weixin', chatId) }}
      />

      <ChannelCard
        t={t}
        channel={telegram}
        id="telegram"
        title={t('remoteChannelTelegram')}
        code={codes.telegram}
        disabled={disabled}
        token={token}
        onTokenChange={setToken}
        onConnectToken={() => {
          const value = token.trim()
          if (value === '') return
          void run('telegram-connect', async remote => {
            const result = await agentEnhancerRemoteTelegramConnect.invoke(remote, { token: value })
            if (result.ok) setToken('')
            return result
          })
        }}
        onBindCode={() => { issueCode('telegram') }}
        onLogout={() => { logout('telegram') }}
        onRevoke={chatId => { revoke('telegram', chatId) }}
        showBotFather={showBotFather}
        onToggleBotFather={() => { setShowBotFather(current => !current) }}
      />
        </>
      ) : null}
    </div>
  )
}

interface ChannelCardProps {
  readonly t: TranslateNS<'agent-enhancer'>
  readonly channel: RemoteChannelStatusWire | undefined
  readonly id: RemoteChannelIdWire
  readonly title: string
  readonly code: string | undefined
  readonly disabled: boolean
  readonly token?: string
  readonly onTokenChange?: (value: string) => void
  readonly onConnectToken?: () => void
  readonly showBotFather?: boolean
  readonly onToggleBotFather?: () => void
  readonly onLogin?: () => void
  readonly onCancel?: () => void
  readonly onBindCode: () => void
  readonly onLogout: () => void
  readonly onRevoke: (chatId: string) => void
}

function ChannelCard(props: ChannelCardProps) {
  const { t, channel, id, title, code, disabled } = props
  const phase = channel?.phase ?? 'off'
  const login = channel?.login
  const qrUrl = login?.qrUrl
  const waiting = login?.phase === 'waiting' && qrUrl !== undefined
  const connected = phase === 'running'
  const devices = channel?.devices ?? []

  return (
    <section className={styles.remoteChannelCard} data-channel={id}>
      <header className={styles.remoteChannelHeader}>
        <span className={styles.remoteChannelName}>{title}</span>
        <span className={styles.remotePhase} data-phase={phase}>
          {t(`remoteChannelPhase_${phase}` as 'remoteChannelPhase_off')}
        </span>
        {channel?.handle !== undefined ? (
          <span className={styles.remoteHint} title={channel.handle}>{channel.handle}</span>
        ) : null}
        {connected ? (
          <button
            type="button"
            className={styles.settingsLink}
            disabled={disabled}
            onClick={props.onLogout}
          >
            {t('remoteLogout')}
          </button>
        ) : null}
      </header>

      {channel?.error !== undefined ? (
        <p className={styles.remoteError} role="alert">{channel.error}</p>
      ) : null}

      {id === 'weixin' && waiting ? (
        <div className={styles.remoteQr}>
          <QrCode value={qrUrl} label={t('remoteQrLabel')} />
          <p className={styles.remoteHint}>{t('remoteLoginHint')}</p>
          <p className={styles.remoteHint}>{t('remoteLoginWaiting')}</p>
          <div className={styles.remoteActions}>
            <button type="button" className={styles.settingsLink} disabled={disabled} onClick={props.onCancel}>
              {t('remoteLoginCancel')}
            </button>
            <button type="button" className={styles.settingsLink} disabled={disabled} onClick={props.onLogin}>
              {t('remoteRegenerate')}
            </button>
          </div>
        </div>
      ) : null}

      {id === 'weixin' && !connected && !waiting ? (
        <div className={styles.remoteActions}>
          <button
            type="button"
            className={styles.settingsActionPrimary}
            disabled={disabled}
            onClick={props.onLogin}
          >
            {login?.phase === 'failed' ? t('remoteLoginAgain') : t('remoteLogin')}
          </button>
          {login?.phase === 'failed' ? (
            <span className={styles.remoteHint}>
              {login.status === 'expired' ? t('remoteLoginExpired') : t('remoteLoginFailed')}
            </span>
          ) : null}
        </div>
      ) : null}

      {id === 'telegram' && !connected ? (
        <div className={styles.remoteTokenRow}>
          <input
            className={styles.remoteTokenInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('remoteTelegramTokenPlaceholder')}
            aria-label={t('remoteTelegramToken')}
            disabled={disabled}
            value={props.token ?? ''}
            onChange={event => { props.onTokenChange?.(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter') props.onConnectToken?.()
            }}
          />
          <button
            type="button"
            className={styles.settingsActionPrimary}
            disabled={disabled || (props.token ?? '').trim() === ''}
            onClick={props.onConnectToken}
          >
            {t('remoteTelegramConnect')}
          </button>
        </div>
      ) : null}

      {id === 'telegram' && !connected ? (
        <p className={styles.remoteHint}>{t('remoteTelegramTokenHint')}</p>
      ) : null}

      {id === 'telegram' && !connected ? (
        <div className={styles.remoteBotFather}>
          <button
            type="button"
            className={styles.settingsLink}
            disabled={disabled}
            onClick={props.onToggleBotFather}
          >
            {props.showBotFather ? t('remoteTelegramHideBotFather') : t('remoteTelegramOpenBotFather')}
          </button>
          {props.showBotFather ? (
            <div className={styles.remoteQr}>
              <QrCode value="https://t.me/BotFather" size={140} label={t('remoteTelegramQrLabel')} />
              <p className={styles.remoteHint}>{t('remoteTelegramQrHint')}</p>
              <p className={styles.remoteHint}>{t('remoteTelegramNameHint')}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {connected ? (
        <div className={styles.remoteActions}>
          <button
            type="button"
            className={styles.settingsLink}
            disabled={disabled}
            onClick={props.onBindCode}
          >
            {t('remoteBindCode')}
          </button>
        </div>
      ) : null}

      {code !== undefined ? (
        <div className={styles.remoteBind}>
          <span className={styles.remoteCode}>{code}</span>
          <p className={styles.remoteHint}>{t('remoteBindCodeHint')}</p>
          <p className={styles.remoteHint}>{t('remoteBindCodeExpires')}</p>
        </div>
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
                <span className={styles.remoteHint}>{new Date(device.boundAt).toLocaleDateString()}</span>
                <button
                  type="button"
                  className={styles.settingsLink}
                  disabled={disabled}
                  onClick={() => { props.onRevoke(device.chatId) }}
                >
                  {t('remoteRevoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
