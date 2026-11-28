import { appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BindingStore, REMOTE_CHANNELS } from './bindings.ts'
import type { RemoteChannel } from './bindings.ts'
import type { ChannelStatus, HubStatus } from './channels/status.ts'
import type { RemoteController } from './controller.ts'
import { installRemoteHostBridge } from './host-bridge.ts'
import type { BridgeNotice, HostBridge } from './host-bridge.ts'
import { createHostPorts } from './ports.ts'
import type { ChannelCapabilities } from './types.ts'
import { TelegramChannel } from './telegram/channel.ts'
import { createTelegramCredentialStore } from './telegram/credentials.ts'
import type { TelegramCredentialStore } from './telegram/credentials.ts'
import { TelegramTransport } from './telegram/transport.ts'
import { FeishuChannel } from './feishu/channel.ts'
import { createFeishuCredentialStore } from './feishu/credentials.ts'
import type { FeishuCredentialStore } from './feishu/credentials.ts'
import { FeishuTransport } from './feishu/transport.ts'
import { WEIXIN_CAPABILITIES } from './weixin/capabilities.ts'
import { WeixinChannel } from './weixin/channel.ts'
import { createWeixinCredentialStore } from './weixin/credentials.ts'
import type { WeixinCredentialStore } from './weixin/credentials.ts'
import { WeixinTransport } from './weixin/transport.ts'
import type { LoginTicket } from './weixin/transport.ts'

export interface RemoteHubOptions {
  readonly ctx: Context
  /** plugin-data/<package>/remote — bindings and cursors only. */
  readonly rootDir: string
  readonly setPaused: (sessionId: string, paused: boolean) => Promise<void>
  readonly createWeixinTransport?: () => WeixinTransport
  readonly createTelegramTransport?: () => TelegramTransport
  readonly createFeishuTransport?: () => FeishuTransport
  readonly weixinCredentials?: WeixinCredentialStore
  readonly telegramCredentials?: TelegramCredentialStore
  readonly feishuCredentials?: FeishuCredentialStore
  readonly weixinCapabilities?: ChannelCapabilities
  readonly telegramCapabilities?: ChannelCapabilities
  readonly feishuCapabilities?: ChannelCapabilities
  readonly onError?: (error: unknown) => void
  /** Desktop-side warning channel; used when a push surface goes stale. */
  readonly desktopNotify?: (input: { readonly title: string; readonly body: string; readonly tag: string }) => void
  /** Tests use 1ms; production polls already held for ~35s. */
  readonly emptyPageDelayMs?: number
}

const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  buttons: true,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 4_000,
  privateOnly: true,
}

const FEISHU_CAPABILITIES: ChannelCapabilities = {
  buttons: true,
  editMessage: false,
  threads: false,
  media: 'none',
  markdown: false,
  maxChars: 3_000,
  privateOnly: true,
}

const RETRY_DELAY_MS = 5_000
const MAX_RETRIES = 12

function offStatus(id: RemoteChannel): ChannelStatus {
  return { id, phase: 'off', login: { phase: 'idle', status: 'idle' }, devices: [] }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clip(value: string, max: number): string {
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Owns every channel, one task board, one host bridge.
 *
 * The board and the bridge are shared on purpose: host events, the session list
 * and all chats must read the same controller. A channel only adds transport,
 * credentials and its own cursor.
 */
export class RemoteHub {
  private bindings: BindingStore | undefined
  private controller: RemoteController | undefined
  private bridge: HostBridge | undefined
  private weixin: WeixinChannel | undefined
  private telegram: TelegramChannel | undefined
  private feishu: FeishuChannel | undefined
  private phaseValue: HubStatus['phase'] = 'stopped'
  private errorValue: string | undefined
  private startingPromise: Promise<HubStatus> | undefined
  private recoverable = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0
  private generation = 0
  private lastWechatWarnAt = 0
  private readonly channelEnabled = new Map<RemoteChannel, boolean>()
  private readonly weixinCapabilities: ChannelCapabilities
  private readonly telegramCapabilities: ChannelCapabilities
  private readonly feishuCapabilities: ChannelCapabilities
  private readonly weixinCredentials: WeixinCredentialStore
  private readonly telegramCredentials: TelegramCredentialStore
  private readonly feishuCredentials: FeishuCredentialStore

  constructor(private readonly options: RemoteHubOptions) {
    this.weixinCapabilities = options.weixinCapabilities ?? WEIXIN_CAPABILITIES
    this.telegramCapabilities = options.telegramCapabilities ?? TELEGRAM_CAPABILITIES
    this.feishuCapabilities = options.feishuCapabilities ?? FEISHU_CAPABILITIES
    this.weixinCredentials = options.weixinCredentials ?? createWeixinCredentialStore(options.ctx)
    this.telegramCredentials = options.telegramCredentials ?? createTelegramCredentialStore(options.ctx)
    this.feishuCredentials = options.feishuCredentials ?? createFeishuCredentialStore(options.ctx)
  }

  get running(): boolean {
    return this.anyRunning()
  }

  private anyRunning(): boolean {
    return this.weixin?.running === true || this.telegram?.running === true || this.feishu?.running === true
  }

  status(): HubStatus {
    this.checkWechatFreshness()
    const weixin = this.weixin
    const telegram = this.telegram
    const feishu = this.feishu
    const started = weixin !== undefined && telegram !== undefined && feishu !== undefined
    const channels = started
      ? [weixin, telegram, feishu].map(channel => ({
        ...channel.status(),
        enabled: this.channelEnabled.get(channel.id) !== false,
      }))
      : [offStatus('weixin'), offStatus('telegram'), offStatus('feishu')].map(channel => ({
        ...channel,
        enabled: this.channelEnabled.get(channel.id) !== false,
      }))
    let phase: HubStatus['phase']
    if (!started) {
      phase = this.phaseValue === 'failed' ? 'failed' : this.phaseValue
    } else if (channels.some(channel => channel.phase === 'running')) {
      phase = 'running'
    } else if (channels.every(channel => channel.phase === 'failed')) {
      phase = 'failed'
    } else {
      phase = 'unbound'
    }
    return {
      phase,
      channels,
      tasks: this.controller?.tasks().length ?? 0,
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
    }
  }

  async start(): Promise<HubStatus> {
    if (this.startingPromise !== undefined) return this.startingPromise
    const retryable = this.phaseValue === 'failed' && this.recoverable
    if (this.phaseValue !== 'stopped' && !retryable) return this.status()
    this.startingPromise = this.startInternal().finally(() => {
      this.startingPromise = undefined
    })
    return this.startingPromise
  }

  private async startInternal(): Promise<HubStatus> {
    const generation = this.generation
    this.recoverable = false
    this.disposeChannels()
    this.bridge?.dispose()
    this.controller?.releasePending()
    this.bridge = undefined
    this.controller = undefined

    const bindings = this.bindings ?? new BindingStore({
      filePath: join(this.options.rootDir, 'bindings.json'),
    })
    this.bindings = bindings
    const ports = createHostPorts(this.options.ctx, {
      setPaused: this.options.setPaused,
      notify: notice => this.pushNotice(notice),
    })
    this.bridge = installRemoteHostBridge(this.options.ctx, {
      ports,
      capabilities: this.weixinCapabilities,
      shouldHold: () => bindings.list().length > 0 && this.anyRunning(),
      debugLog: line => {
        try {
          this.debugNotice({ stage: 'bridge', detail: JSON.parse(line) as unknown })
        } catch {
          // Ignore malformed diagnostic lines.
        }
      },
    })
    this.controller = this.bridge.controller

    try {
      await this.bridge.refreshSessions()
    } catch (error) {
      this.phaseValue = 'failed'
      this.errorValue = messageOf(error)
      this.recoverable = true
      this.scheduleRetry()
      return this.status()
    }
    if (this.generation !== generation) return this.status()
    this.errorValue = undefined
    this.retries = 0
    this.clearRetry()

    for (const binding of bindings.list()) {
      if (binding.focusSessionId !== undefined) {
        this.controller.setFocus(binding.chatId, binding.focusSessionId)
      }
    }

    this.weixin = new WeixinChannel({
      ctx: this.options.ctx,
      rootDir: this.options.rootDir,
      capabilities: this.weixinCapabilities,
      credentials: this.weixinCredentials,
      bindings,
      controller: this.controller,
      refresh: () => this.bridge?.refreshSessions() ?? Promise.resolve(0),
      ...(this.options.createWeixinTransport === undefined
        ? {}
        : { createTransport: this.options.createWeixinTransport }),
      ...(this.options.onError === undefined ? {} : { onError: this.options.onError }),
      ...(this.options.emptyPageDelayMs === undefined
        ? {}
        : { emptyPageDelayMs: this.options.emptyPageDelayMs }),
    })
    this.telegram = new TelegramChannel({
      rootDir: this.options.rootDir,
      capabilities: this.telegramCapabilities,
      credentials: this.telegramCredentials,
      bindings,
      controller: this.controller,
      refresh: () => this.bridge?.refreshSessions() ?? Promise.resolve(0),
      ...(this.options.createTelegramTransport === undefined
        ? {}
        : { createTransport: this.options.createTelegramTransport }),
      ...(this.options.onError === undefined ? {} : { onError: this.options.onError }),
      ...(this.options.emptyPageDelayMs === undefined
        ? {}
        : { emptyPageDelayMs: this.options.emptyPageDelayMs }),
    })
    this.feishu = new FeishuChannel({
      capabilities: this.feishuCapabilities,
      credentials: this.feishuCredentials,
      bindings,
      controller: this.controller,
      refresh: () => this.bridge?.refreshSessions() ?? Promise.resolve(0),
      ...(this.options.createFeishuTransport === undefined
        ? {}
        : { createTransport: this.options.createFeishuTransport }),
      ...(this.options.onError === undefined ? {} : { onError: this.options.onError }),
      ...(this.options.emptyPageDelayMs === undefined
        ? {}
        : { emptyPageDelayMs: this.options.emptyPageDelayMs }),
    })

    await Promise.all([this.weixin, this.telegram, this.feishu].map(async channel => {
      if (this.channelEnabled.get(channel.id) === false) return
      await channel.start()
    }))
    this.refreshPhase()
    return this.status()
  }

  /** QR login for WeChat; connects when the scan is confirmed. */
  async beginWeixinLogin(): Promise<LoginTicket> {
    await this.start()
    if (this.weixin === undefined) throw new Error('远程控制还没有启动')
    return this.weixin.beginLogin()
  }

  cancelWeixinLogin(): void {
    this.weixin?.cancelLogin()
  }

  /** Validate and connect the Telegram bot. */
  async connectTelegram(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
    await this.start()
    if (this.telegram === undefined) return { ok: false, error: '远程控制还没有启动' }
    const result = await this.telegram.connect(token)
    this.refreshPhase()
    return result
  }

  /** Validate the Feishu app credentials and open the long connection. */
  async connectFeishu(appId: string, appSecret: string): Promise<{ ok: boolean; name?: string; error?: string }> {
    await this.start()
    if (this.feishu === undefined) return { ok: false, error: '远程控制还没有启动' }
    const result = await this.feishu.connect(appId, appSecret)
    this.refreshPhase()
    return result
  }

  /** One-shot pairing code for the given channel. */
  issueBindCode(channel: RemoteChannel): { code: string; expiresAt: number } {
    if (this.bindings === undefined) throw new Error('远程控制还没有启动')
    return this.bindings.issueCode(undefined, channel)
  }

  devices(channel?: RemoteChannel): { chatId: string; boundAt: number; channel: RemoteChannel }[] {
    return (this.bindings?.list() ?? [])
      .filter(binding => channel === undefined || binding.channel === channel)
      .map(binding => ({ chatId: binding.chatId, boundAt: binding.boundAt, channel: binding.channel }))
  }

  revoke(channel: RemoteChannel | undefined, chatId?: string): number {
    if (this.bindings === undefined) return 0
    if (chatId !== undefined) {
      return this.bindings.unbind(chatId) ? 1 : 0
    }
    const targets = this.bindings.list().filter(binding => channel === undefined || binding.channel === channel)
    for (const binding of targets) this.bindings.unbind(binding.chatId)
    return targets.length
  }

  /** Apply persisted per-channel switches; safe before the hub has started. */
  applyChannelSettings(enabled: Record<RemoteChannel, boolean>): void {
    for (const channel of REMOTE_CHANNELS) {
      const before = this.channelEnabled.get(channel) !== false
      const wanted = enabled[channel] !== false
      this.channelEnabled.set(channel, wanted)
      if (before === wanted) continue
      const runtime = channel === 'weixin'
        ? this.weixin
        : channel === 'telegram'
          ? this.telegram
          : this.feishu
      if (runtime === undefined) continue
      if (wanted) {
        if (this.phaseValue !== 'stopped') void runtime.start().catch(error => this.options.onError?.(error))
      } else {
        runtime.stop()
      }
    }
    // Before start() the channels do not exist yet: only record the desired
    // flags; startInternal() honours them. Do not move phase off `stopped`,
    // otherwise start() refuses to boot.
    if (this.weixin !== undefined) {
      if (!this.anyRunning()) this.controller?.releasePending()
      this.refreshPhase()
    }
  }

  /** Pause one channel without touching its credentials or pairing codes. */
  setChannelEnabled(channel: RemoteChannel, enabled: boolean): boolean {
    const runtime = channel === 'weixin'
      ? this.weixin
      : channel === 'telegram'
        ? this.telegram
        : this.feishu
    if (runtime === undefined) return false
    this.channelEnabled.set(channel, enabled)
    if (!enabled) {
      runtime.stop()
      // Nobody left to answer: do not leave a tool waiting on a dead surface.
      if (!this.anyRunning()) this.controller?.releasePending()
    } else if (this.phaseValue !== 'stopped') {
      void runtime.start().catch(error => this.options.onError?.(error))
    }
    this.refreshPhase()
    return true
  }

  async logout(channel?: RemoteChannel): Promise<void> {
    if (channel === undefined || channel === 'weixin') await this.weixin?.logout()
    if (channel === undefined || channel === 'telegram') await this.telegram?.logout()
    if (channel === undefined || channel === 'feishu') await this.feishu?.logout()
    // Only release held asks when nobody is left who could answer them.
    if (!this.anyRunning()) this.controller?.releasePending()
    this.refreshPhase()
  }

  /** Session deleted: drop it from the board and clear any chat that followed it. */
  forgetSession(sessionId: string): void {
    this.controller?.untrack(sessionId)
    for (const binding of this.bindings?.list() ?? []) {
      if (binding.focusSessionId === sessionId) this.bindings?.setFocus(binding.chatId, undefined)
    }
  }

  stop(): void {
    this.generation += 1
    this.clearRetry()
    this.retries = 0
    this.controller?.releasePending()
    this.disposeChannels()
    this.bridge?.dispose()
    this.bridge = undefined
    this.controller = undefined
    this.bindings = undefined
    this.phaseValue = 'stopped'
    this.errorValue = undefined
  }

  private disposeChannels(): void {
    this.weixin?.stop()
    this.telegram?.stop()
    this.feishu?.stop()
    this.weixin = undefined
    this.telegram = undefined
    this.feishu = undefined
  }

  private refreshPhase(): void {
    const channels = [this.weixin, this.telegram, this.feishu].filter(channel => channel !== undefined)
    if (channels.some(channel => channel.running)) {
      this.phaseValue = 'running'
      this.errorValue = undefined
      return
    }
    this.phaseValue = channels.length > 0 && channels.every(channel => channel.status().phase === 'failed')
      ? 'failed'
      : 'unbound'
  }

  /**
   * WeChat only allows proactive sends while a recent inbound message has
   * renewed the session. Warn while the user is still at the desktop instead
   * of failing silently after they walk away.
   */
  private checkWechatFreshness(): void {
    const weixin = this.weixin
    if (weixin === undefined || !weixin.running) return
    if (!(this.bindings?.list().some(binding => binding.channel === 'weixin') ?? false)) return
    const last = weixin.lastInbound
    if (last === 0 || Date.now() - last < 2 * 60 * 60_000) return
    weixin.reportStale()
    this.warnWechatStale('idle')
  }

  private warnWechatStale(reason: 'expired' | 'idle'): void {
    const now = Date.now()
    if (now - this.lastWechatWarnAt < 12 * 60 * 60_000) return
    this.lastWechatWarnAt = now
    this.options.desktopNotify?.({
      title: '微信远程推送可能收不到',
      body: reason === 'expired'
        ? '微信会话已过期。离开电脑前给机器人发一条消息，否则审批和回答推不到微信。'
        : '超过 2 小时没有微信消息。离开电脑前给机器人发一条消息，确保还能收到审批。',
      tag: 'remote-wechat-stale',
    })
  }

  /** Opt-in diagnostics: create `remote/debug-notices.enabled` in plugin-data. */
  private debugNotice(entry: Record<string, unknown>): void {
    try {
      if (!existsSync(join(this.options.rootDir, 'debug-notices.enabled'))) return
      appendFileSync(
        join(this.options.rootDir, 'notice-log.jsonl'),
        `${JSON.stringify({ at: Date.now(), ...entry })}\n`,
      )
    } catch {
      // Diagnostics must never break notice delivery.
    }
  }

  /** Send one notice to every paired chat on a channel that can answer. */
  private pushNotice(notice: BridgeNotice): void {
    const controller = this.controller
    if (controller === undefined || this.bindings === undefined) return
    for (const binding of this.bindings.list()) {
      const channel = binding.channel === 'weixin'
        ? this.weixin
        : binding.channel === 'telegram'
          ? this.telegram
          : this.feishu
      if (channel === undefined || !channel.running) continue
      const capabilities = binding.channel === 'weixin'
        ? this.weixinCapabilities
        : binding.channel === 'telegram'
          ? this.telegramCapabilities
          : this.feishuCapabilities
      let text = controller.renderCard(notice.sessionId, capabilities)
      if (text === undefined) continue
      if (notice.kind === 'failed' && notice.error !== undefined) {
        text += `\n${clip(notice.error, 300)}`
      }
      if (notice.kind === 'done' && notice.answer !== undefined) {
        const answer = clip(notice.answer, 6_000)
        if (answer !== '') text += `\n\n${answer}`
      }
      if (notice.kind === 'decided') {
        const channel = notice.chatId === undefined
          ? undefined
          : this.bindings?.binding(notice.chatId)?.channel
        const where = channel === undefined
          ? '桌面'
          : channel === 'weixin'
            ? '微信'
            : channel === 'telegram'
              ? 'Telegram'
              : '飞书'
        const verb = notice.decision === 'approve'
          ? '批准'
          : notice.decision === 'reject'
            ? '拒绝'
            : '回答'
        text += `\n\n已由${where}${verb}`
      }
      const task = controller.tasks().find(entry => entry.id === notice.sessionId)
      const pending = task?.pending
      let buttons: { label: string; command: string }[] | undefined
      if (capabilities.buttons) {
        const number = controller.numberOf(notice.sessionId)
        if (pending !== undefined) {
          if (pending.kind === 'approval') {
            buttons = [
              { label: '批准', command: `批准 ${pending.code}` },
              { label: '拒绝', command: `拒绝 ${pending.code}` },
              { label: '详情', command: number === undefined ? '详情' : `详情 ${number}` },
            ]
          } else if (pending.options !== undefined && pending.options.length > 0) {
            buttons = pending.options.map(option => ({
              label: option,
              command: `回答 ${pending.code} ${option}`,
            }))
          }
        } else if (notice.kind === 'done' || notice.kind === 'failed' || notice.kind === 'decided') {
          // Reading the answer and replying afterwards go through this task.
          buttons = [{ label: '详情', command: number === undefined ? '详情' : `详情 ${number}` }]
        }
      }
      this.debugNotice({
        stage: 'queued',
        kind: notice.kind,
        channel: binding.channel,
        chatId: binding.chatId,
        sessionId: notice.sessionId,
      })
      void channel.send(binding.chatId, text, buttons)
        .then(() => {
          this.debugNotice({
            stage: 'sent',
            kind: notice.kind,
            channel: binding.channel,
            chatId: binding.chatId,
            sessionId: notice.sessionId,
          })
        })
        .catch(error => {
          this.debugNotice({
            stage: 'error',
            kind: notice.kind,
            channel: binding.channel,
            chatId: binding.chatId,
            sessionId: notice.sessionId,
            error: messageOf(error),
            code: (error as { code?: unknown }).code,
            detail: (error as { detail?: unknown }).detail,
          })
          channel.reportSendError(error)
          if (binding.channel === 'weixin'
            && (error as { detail?: { providerCode?: unknown } }).detail?.providerCode === '-2') {
            this.warnWechatStale('expired')
          }
          this.options.onError?.(error)
        })
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || !this.recoverable || this.retries >= MAX_RETRIES) return
    this.retries += 1
    const timer = setTimeout(() => {
      this.retryTimer = undefined
      if (!this.recoverable || this.phaseValue === 'stopped') return
      void this.start().catch(() => {})
    }, RETRY_DELAY_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.retryTimer = timer
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}
