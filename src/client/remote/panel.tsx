import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useRef, useState } from 'react'
import type { RemoteChannelIdWire, RemoteChannelStatusWire, RemoteStatusWire } from '../../host/rpc.ts'
import type { SettingsPersistOp } from '../dsh/persist-settings.ts'
import styles from '../styles.module.css'
import {
  agentEnhancerRemoteBindCode,
  agentEnhancerRemoteFeishuConnect,
  agentEnhancerRemoteLoginBegin,
  agentEnhancerRemoteLoginCancel,
  agentEnhancerRemoteLogout,
  agentEnhancerRemoteRevoke,
  agentEnhancerRemoteStatus,
  agentEnhancerRemoteTelegramConnect,
  agentEnhancerRemoteSetChannelEnabled,
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
  /** Persist channel switches; the master switch stays in Features. */
  readonly persist?: (ops: readonly SettingsPersistOp[]) => Promise<void>
}

const POLL_MS = 3_000

/**
 * Scopes pasted into the Feishu console's bulk import. `p2p_msg` receives the
 * direct messages, `send_as_bot` answers them, and `readonly` is what the card
 * callback needs before a tapped button is delivered.
 */
const FEISHU_SCOPES = [
  '{',
  '  "scopes": {',
  '    "tenant": [',
  '      "im:message.p2p_msg:readonly",',
  '      "im:message:send_as_bot",',
  '      "im:message.readonly"',
  '    ],',
  '    "user": []',
  '  }',
  '}',
].join('\n')

async function copyPlainText(text: string): Promise<void> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
    try {
      await clipboard.writeText(text)
      return
    } catch {
      // A webview can refuse the clipboard API; fall back to a selection copy.
    }
  }
  if (typeof document === 'undefined') throw new Error('clipboard unavailable')
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  const copied = typeof document.execCommand === 'function' && document.execCommand('copy')
  document.body.removeChild(area)
  if (!copied) throw new Error('copy failed')
}

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
export function RemoteSettingsPanel({ t, getRemote, busy, enabled, onOpenFeatures, persist }: RemoteSettingsPanelProps) {
  const [status, setStatus] = useState<RemoteStatusWire | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [codes, setCodes] = useState<Partial<Record<RemoteChannelIdWire, string>>>({})
  const [token, setToken] = useState('')
  const [showBotFather, setShowBotFather] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [showFeishuHelp, setShowFeishuHelp] = useState(false)
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
  const feishu = status?.channels.find(channel => channel.id === 'feishu')

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

  const toggleChannel = (channel: RemoteChannelIdWire, next: boolean): void => {
    void run(`channel-${channel}`, async remote => {
      const field = channel === 'weixin'
        ? 'remoteWeixinEnabled'
        : channel === 'telegram'
          ? 'remoteTelegramEnabled'
          : 'remoteFeishuEnabled'
      if (persist !== undefined) {
        await persist([{ op: 'set', path: [field], value: next }])
      }
      return agentEnhancerRemoteSetChannelEnabled.invoke(remote, { channel, enabled: next })
    })
  }

  return (
    <div className={styles.remoteSettings}>
      <div className={styles.remoteSettingsHeader}>
        <p className={styles.remoteIntro}>{t('remoteSettingsIntro')}</p>
        <div className={styles.remoteSummary}>
          <div className={styles.remoteStat}>
            <span className={styles.remoteStatValue}>
              {status?.channels.filter(channel => channel.phase === 'running' && channel.enabled !== false).length ?? 0}
            </span>
            <span className={styles.remoteStatLabel}>{t('remoteStatChannels')}</span>
          </div>
          <div className={styles.remoteStat}>
            <span className={styles.remoteStatValue}>
              {status?.channels.reduce((total, channel) => total + channel.devices.length, 0) ?? 0}
            </span>
            <span className={styles.remoteStatLabel}>{t('remoteStatChats')}</span>
          </div>
          <div className={styles.remoteStat}>
            <span className={styles.remoteStatValue}>{status?.tasks ?? 0}</span>
            <span className={styles.remoteStatLabel}>{t('remoteStatTasks')}</span>
          </div>
        </div>
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
        onToggleEnabled={enabled => { toggleChannel('weixin', enabled) }}
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
        onToggleEnabled={enabled => { toggleChannel('telegram', enabled) }}
        showBotFather={showBotFather}
        onToggleBotFather={() => { setShowBotFather(current => !current) }}
      />

      <ChannelCard
        t={t}
        channel={feishu}
        id="feishu"
        title={t('remoteChannelFeishu')}
        code={codes.feishu}
        disabled={disabled}
        appId={appId}
        onAppIdChange={setAppId}
        appSecret={appSecret}
        onAppSecretChange={setAppSecret}
        onConnectApp={() => {
          const id = appId.trim()
          const secret = appSecret.trim()
          if (id === '' || secret === '') return
          void run('feishu-connect', async remote => {
            const result = await agentEnhancerRemoteFeishuConnect.invoke(remote, {
              appId: id,
              appSecret: secret,
            })
            if (result.ok) setAppSecret('')
            return result
          })
        }}
        showFeishuHelp={showFeishuHelp}
        onToggleFeishuHelp={() => { setShowFeishuHelp(current => !current) }}
        onBindCode={() => { issueCode('feishu') }}
        onLogout={() => { logout('feishu') }}
        onRevoke={chatId => { revoke('feishu', chatId) }}
        onToggleEnabled={enabled => { toggleChannel('feishu', enabled) }}
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
  readonly appId?: string
  readonly onAppIdChange?: (value: string) => void
  readonly appSecret?: string
  readonly onAppSecretChange?: (value: string) => void
  readonly onConnectApp?: () => void
  readonly showFeishuHelp?: boolean
  readonly onToggleFeishuHelp?: () => void
  readonly onLogin?: () => void
  readonly onCancel?: () => void
  readonly onBindCode: () => void
  readonly onLogout: () => void
  readonly onRevoke: (chatId: string) => void
  readonly onToggleEnabled?: (enabled: boolean) => void
}

function ChannelCard(props: ChannelCardProps) {
  const { t, channel, id, title, code, disabled } = props
  const phase = channel?.phase ?? 'off'
  const login = channel?.login
  const qrUrl = login?.qrUrl
  const waiting = login?.phase === 'waiting' && qrUrl !== undefined
  const connected = phase === 'running'
  const paused = channel?.enabled === false
  const phaseLabel = paused ? t('remoteChannelPhase_paused') : t(`remoteChannelPhase_${phase}` as 'remoteChannelPhase_off')
  const devices = channel?.devices ?? []
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const rawAppId = (props.appId ?? '').trim()
  const appBase = rawAppId.startsWith('cli_')
    ? `https://open.feishu.cn/app/${encodeURIComponent(rawAppId)}`
    : undefined
  const copyScopes = (): void => {
    void copyPlainText(FEISHU_SCOPES)
      .then(() => {
        setCopyFailed(false)
        setCopied(true)
        setTimeout(() => { setCopied(false) }, 1_800)
      })
      .catch(() => {
        setCopyFailed(true)
        setCopied(false)
      })
  }

  return (
    <section className={styles.remoteChannelCard} data-channel={id}>
      <header className={styles.remoteChannelHeader}>
        <span className={styles.remoteChannelName}>{title}</span>
        <span className={styles.remotePhase} data-phase={paused ? 'paused' : phase}>
          {phaseLabel}
        </span>
        {channel?.handle !== undefined ? (
          <span className={styles.remoteHint} title={channel.handle}>{channel.handle}</span>
        ) : null}
        {connected || paused ? (
          <button
            type="button"
            className={styles.settingsLink}
            disabled={disabled}
            onClick={() => { props.onToggleEnabled?.(!connected) }}
          >
            {paused ? t('remoteResumeChannel') : t('remotePauseChannel')}
          </button>
        ) : null}
        {connected ? (
          <button
            type="button"
            className={styles.settingsLink}
            disabled={disabled}
            onClick={props.onLogout}
          >
            {t('remoteDisconnect')}
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

      {id === 'weixin' && !connected && !paused && !waiting ? (
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

      {id === 'telegram' && !connected && !paused ? (
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

      {id === 'telegram' && !connected && !paused ? (
        <p className={styles.remoteHint}>{t('remoteTelegramTokenHint')}</p>
      ) : null}

      {id === 'telegram' && !connected && !paused ? (
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

      {id === 'feishu' && !connected && !paused ? (
        <div className={styles.remoteCredentialFields}>
          <input
            className={styles.remoteTokenInput}
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('remoteFeishuAppIdPlaceholder')}
            aria-label={t('remoteFeishuAppId')}
            disabled={disabled}
            value={props.appId ?? ''}
            onChange={event => { props.onAppIdChange?.(event.target.value) }}
          />
          <input
            className={styles.remoteTokenInput}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('remoteFeishuAppSecretPlaceholder')}
            aria-label={t('remoteFeishuAppSecret')}
            disabled={disabled}
            value={props.appSecret ?? ''}
            onChange={event => { props.onAppSecretChange?.(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter') props.onConnectApp?.()
            }}
          />
        </div>
      ) : null}

      {id === 'feishu' && !connected && !paused ? (
        <div className={styles.remoteFeishuGuide}>
          <span className={styles.remoteFeishuGuideTitle}>{t('remoteFeishuTemplateTitle')}</span>
          <ol className={styles.remoteFeishuSteps}>
            <li className={styles.remoteFeishuStep}>
              <span className={styles.remoteFeishuStepIndex}>1</span>
              <div className={styles.remoteFeishuStepBody}>
                <span className={styles.remoteHint}>{t('remoteFeishuTemplateStep1')}</span>
              </div>
            </li>
            <li className={styles.remoteFeishuStep}>
              <span className={styles.remoteFeishuStepIndex}>2</span>
              <div className={styles.remoteFeishuStepBody}>
                <span className={styles.remoteHint}>{t('remoteFeishuTemplateStep2')}</span>
              </div>
            </li>
            <li className={styles.remoteFeishuStep}>
              <span className={styles.remoteFeishuStepIndex}>3</span>
              <div className={styles.remoteFeishuStepBody}>
                <span className={styles.remoteHint}>{t('remoteFeishuTemplateStep3')}</span>
              </div>
            </li>
          </ol>
          <div className={styles.remoteFeishuStepActions}>
            <a
              className={styles.settingsLink}
              href="https://open.feishu.cn/app"
              target="_blank"
              rel="noreferrer"
            >
              {t('remoteFeishuTemplateOpen')}
            </a>
          </div>
          <div className={styles.remoteFeishuGuideHeader}>
            <button
              type="button"
              className={styles.settingsLink}
              disabled={disabled}
              onClick={props.onToggleFeishuHelp}
            >
              {props.showFeishuHelp ? t('remoteFeishuGuideHide') : t('remoteFeishuGuideShow')}
            </button>
          </div>
          {props.showFeishuHelp ? (
            <>
              <span className={styles.remoteFeishuGuideTitle}>{t('remoteFeishuGuideTitle')}</span>
              <ol className={styles.remoteFeishuSteps}>
                <li className={styles.remoteFeishuStep}>
                  <span className={styles.remoteFeishuStepIndex}>1</span>
                  <div className={styles.remoteFeishuStepBody}>
                    <span className={styles.remoteFeishuStepTitle}>{t('remoteFeishuGuideStepCreate')}</span>
                    <span className={styles.remoteHint}>{t('remoteFeishuGuideCreateHint')}</span>
                    <div className={styles.remoteFeishuStepActions}>
                      <a
                        className={styles.settingsLink}
                        href="https://open.feishu.cn/app"
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('remoteFeishuGuideOpenConsole')}
                      </a>
                    </div>
                  </div>
                </li>
                <li className={styles.remoteFeishuStep}>
                  <span className={styles.remoteFeishuStepIndex}>2</span>
                  <div className={styles.remoteFeishuStepBody}>
                    <span className={styles.remoteFeishuStepTitle}>{t('remoteFeishuGuideStepBot')}</span>
                    <span className={styles.remoteHint}>{t('remoteFeishuGuideBotHint')}</span>
                    <div className={styles.remoteFeishuStepActions}>
                      {appBase === undefined ? null : (
                        <a
                          className={styles.settingsLink}
                          href={`${appBase}/auth`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('remoteFeishuGuidePermissions')}
                        </a>
                      )}
                      <button type="button" className={styles.settingsLink} onClick={copyScopes}>
                        {copied ? t('remoteFeishuGuideCopied') : t('remoteFeishuGuideCopyScopes')}
                      </button>
                    </div>
                  </div>
                </li>
                <li className={styles.remoteFeishuStep}>
                  <span className={styles.remoteFeishuStepIndex}>3</span>
                  <div className={styles.remoteFeishuStepBody}>
                    <span className={styles.remoteFeishuStepTitle}>{t('remoteFeishuGuideStepEvents')}</span>
                    <span className={styles.remoteHint}>{t('remoteFeishuGuideEventsHint')}</span>
                    <div className={styles.remoteFeishuStepActions}>
                      {appBase === undefined ? null : (
                        <a
                          className={styles.settingsLink}
                          href={`${appBase}/event?tab=event`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('remoteFeishuGuideEventConfig')}
                        </a>
                      )}
                    </div>
                  </div>
                </li>
                <li className={styles.remoteFeishuStep}>
                  <span className={styles.remoteFeishuStepIndex}>4</span>
                  <div className={styles.remoteFeishuStepBody}>
                    <span className={styles.remoteFeishuStepTitle}>{t('remoteFeishuGuideStepCallback')}</span>
                    <span className={styles.remoteHint}>{t('remoteFeishuGuideCallbackHint')}</span>
                    <div className={styles.remoteFeishuStepActions}>
                      {appBase === undefined ? null : (
                        <a
                          className={styles.settingsLink}
                          href={`${appBase}/event?tab=callback`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('remoteFeishuGuideCallbackConfig')}
                        </a>
                      )}
                    </div>
                  </div>
                </li>
                <li className={styles.remoteFeishuStep}>
                  <span className={styles.remoteFeishuStepIndex}>5</span>
                  <div className={styles.remoteFeishuStepBody}>
                    <span className={styles.remoteFeishuStepTitle}>{t('remoteFeishuGuideStepPublish')}</span>
                    <span className={styles.remoteHint}>{t('remoteFeishuGuidePublishHint')}</span>
                    <div className={styles.remoteFeishuStepActions}>
                      {appBase === undefined ? null : (
                        <a
                          className={styles.settingsLink}
                          href={appBase}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {t('remoteFeishuGuideOpenApp')}
                        </a>
                      )}
                    </div>
                  </div>
                </li>
              </ol>
              {appBase === undefined ? (
                <p className={styles.remoteHint}>{t('remoteFeishuGuideNeedId')}</p>
              ) : null}
              {copyFailed ? (
                <>
                  <p className={styles.remoteHint}>{t('remoteFeishuGuideCopyFailed')}</p>
                  <pre className={styles.remoteFeishuScopes}>{FEISHU_SCOPES}</pre>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {id === 'feishu' && !connected && !paused ? (
        <>
          <p className={styles.remoteHint}>{t('remoteFeishuHint')}</p>
          <div className={styles.remoteActions}>
            <button
              type="button"
              className={styles.settingsActionPrimary}
              disabled={disabled || (props.appId ?? '').trim() === '' || (props.appSecret ?? '').trim() === ''}
              onClick={props.onConnectApp}
            >
              {t('remoteFeishuConnect')}
            </button>
            <span className={styles.remoteHint}>{t('remoteFeishuGuideConnectHint')}</span>
          </div>
        </>
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

      {id === 'feishu' && connected && devices.length === 0 ? (
        <p className={styles.remoteHint}>{t('remoteFeishuNoChatHint')}</p>
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
