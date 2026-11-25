import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BindingStore } from '../bindings.ts'
import { RemoteController } from '../controller.ts'
import { installRemoteHostBridge } from '../host-bridge.ts'
import type { HostBridge } from '../host-bridge.ts'
import { createHostPorts } from '../ports.ts'
import type { ChannelCapabilities } from '../types.ts'
import { WeixinAdapter } from './adapter.ts'
import { createCursorStore } from './cursor.ts'
import type { CursorStore } from './cursor.ts'
import type { WeixinCredentialStore } from './credentials.ts'
import { WeixinLogin } from './login.ts'
import type { LoginSnapshot } from './login.ts'
import { WeixinTransport } from './transport.ts'
import type { LoginPoll, LoginTicket, UpdatesPage, WeixinCredentials } from './transport.ts'

export type RuntimePhase = 'stopped' | 'unbound' | 'running' | 'failed'

export interface RuntimeDevice {
  readonly chatId: string
  readonly boundAt: number
  readonly channel: string
}

export interface RuntimeStatus {
  readonly phase: RuntimePhase
  readonly login: LoginSnapshot
  readonly devices: readonly RuntimeDevice[]
  readonly botId?: string
  readonly error?: string
  /** Sessions currently on the board; zero is a real answer, not an error. */
  readonly tasks: number
}

export type RuntimeTransport = {
  beginLogin(localTokens?: readonly string[]): Promise<LoginTicket>
  pollLogin(ticket: string, verifyCode?: string): Promise<LoginPoll>
  getUpdates(credentials: WeixinCredentials, cursor?: string): Promise<UpdatesPage>
  sendText(
    credentials: WeixinCredentials,
    toUserId: string,
    text: string,
    options?: { readonly contextToken?: string },
  ): Promise<number>
}

export interface RemoteRuntimeOptions {
  readonly ctx: Context
  /** plugin-data/<package>/remote — bindings and cursor only. */
  readonly rootDir: string
  readonly capabilities: ChannelCapabilities
  readonly setPaused: (sessionId: string, paused: boolean) => Promise<void>
  readonly credentials: WeixinCredentialStore
  readonly createTransport?: () => RuntimeTransport
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
  /** Tests use 1ms; production polls already held for ~35s. */
  readonly emptyPageDelayMs?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Owns one WeChat channel: transport, login, bindings, cursor, the host bridge,
 * the poll loop.
 *
 * `start` is idempotent and leaves the runtime `unbound` when no credentials
 * exist yet; `beginLogin` drives the QR flow and connects on confirmation. A
 * failed bridge (no apiProxy) fails the runtime instead of half-working.
 */
export class RemoteRuntime {
  private readonly transport: RuntimeTransport
  private readonly login: WeixinLogin
  private bindings: BindingStore | undefined
  private cursor: CursorStore | undefined
  private controller: RemoteController | undefined
  private bridge: HostBridge | undefined
  private adapter: WeixinAdapter | undefined
  private credentialsValue: WeixinCredentials | undefined
  private phaseValue: RuntimePhase = 'stopped'
  private errorValue: string | undefined
  /** Bumped by stop/logout so an in-flight scan result cannot reconnect. */
  private generation = 0
  /** One setup at a time; callers await the same promise. */
  private startingPromise: Promise<RuntimeStatus> | undefined
  /** A bridge failure may heal (service not registered yet); a stale token may not. */
  private recoverable = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retries = 0

  constructor(private readonly options: RemoteRuntimeOptions) {
    this.transport = options.createTransport?.() ?? new WeixinTransport()
    this.login = new WeixinLogin({ transport: this.transport })
  }

  get running(): boolean {
    return this.phaseValue === 'running'
  }

  status(): RuntimeStatus {
    return {
      phase: this.phaseValue,
      login: this.login.snapshot(),
      devices: (this.bindings?.list() ?? []).map(binding => ({
        chatId: binding.chatId,
        boundAt: binding.boundAt,
        channel: binding.channel,
      })),
      tasks: this.controller?.tasks().length ?? 0,
      ...(this.credentialsValue?.botId === undefined ? {} : { botId: this.credentialsValue.botId }),
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
    }
  }

  async start(): Promise<RuntimeStatus> {
    if (this.startingPromise !== undefined) return this.startingPromise
    const retryable = this.phaseValue === 'failed' && this.recoverable
    if (this.phaseValue !== 'stopped' && !retryable) return this.status()
    this.startingPromise = this.startInternal().finally(() => {
      this.startingPromise = undefined
    })
    return this.startingPromise
  }

  private async startInternal(): Promise<RuntimeStatus> {
    const generation = this.generation
    this.recoverable = false
    // A retry replaces the half-built bridge from the failed attempt.
    this.adapter?.stop()
    this.bridge?.dispose()
    this.controller?.releasePending()
    this.adapter = undefined
    this.bridge = undefined
    this.controller = undefined
    this.bindings = new BindingStore({
      filePath: join(this.options.rootDir, 'bindings.json'),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    this.cursor = createCursorStore({ filePath: join(this.options.rootDir, 'cursor.json') })
    const ports = createHostPorts(this.options.ctx, { setPaused: this.options.setPaused })
    this.bridge = installRemoteHostBridge(this.options.ctx, {
      ports,
      capabilities: this.options.capabilities,
      shouldHold: () => this.phaseValue === 'running' && (this.bindings?.list().length ?? 0) > 0,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    // One board, owned by the bridge: it is the object host events write into.
    this.controller = this.bridge.controller
    try {
      await this.bridge.refreshSessions()
    } catch (error) {
      this.phaseValue = 'failed'
      this.errorValue = messageOf(error)
      // The host service can register after plugin boot; keep trying on our own,
      // so a user who never opens Settings still gets a working channel.
      this.recoverable = true
      this.scheduleRetry()
      return this.status()
    }
    this.errorValue = undefined
    this.retries = 0
    this.clearRetry()
    // A stop/dispose landed while sessions were loading: the runtime is gone.
    if (this.generation !== generation) return this.status()
    const stored = await this.options.credentials.load().catch(() => undefined)
    if (this.generation !== generation) return this.status()
    if (stored !== undefined) {
      await this.connect(stored)
    } else {
      this.phaseValue = 'unbound'
    }
    return this.status()
  }

  /** Start a fresh QR login; connecting happens when the scan is confirmed. */
  async beginLogin(): Promise<LoginTicket> {
    await this.start()
    const generation = this.generation
    const ticket = await this.login.begin()
    void this.login.wait().then(credentials => {
      // A logout or stop while the code was being scanned must win.
      if (credentials !== undefined && this.generation === generation) void this.connect(credentials)
    })
    return ticket
  }

  /** Abandon the QR currently on screen without touching a live connection. */
  cancelLogin(): void {
    this.login.cancel()
    if (this.phaseValue === 'unbound' || this.phaseValue === 'failed') {
      this.errorValue = undefined
      this.phaseValue = 'unbound'
    }
  }

  /**
   * Forget the WeChat login. Bindings survive (they are about chats, not the
   * bot), but the adapter stops until a new scan confirms.
   */
  async logout(): Promise<void> {
    this.generation += 1
    this.clearRetry()
    this.retries = 0
    this.controller?.releasePending()
    this.adapter?.stop()
    this.adapter = undefined
    this.login.cancel()
    this.credentialsValue = undefined
    this.errorValue = undefined
    this.recoverable = false
    await this.options.credentials.clear().catch(error => {
      this.options.onError?.(error)
    })
    if (this.phaseValue !== 'stopped') this.phaseValue = 'unbound'
  }

  /** One-shot pairing code for an unbound chat. */
  issueBindCode(): { code: string; expiresAt: number } {
    if (this.bindings === undefined) throw new Error('远程控制还没有启动')
    return this.bindings.issueCode()
  }

  devices(): readonly RuntimeDevice[] {
    return (this.bindings?.list() ?? []).map(binding => ({
      chatId: binding.chatId,
      boundAt: binding.boundAt,
      channel: binding.channel,
    }))
  }

  revoke(chatId?: string): boolean {
    if (this.bindings === undefined) return false
    if (chatId === undefined) {
      const had = this.bindings.list().length > 0
      this.bindings.unbindAll()
      return had
    }
    return this.bindings.unbind(chatId)
  }

  stop(): void {
    this.generation += 1
    this.clearRetry()
    this.retries = 0
    this.controller?.releasePending()
    this.adapter?.stop()
    this.bridge?.dispose()
    this.login.cancel()
    this.adapter = undefined
    this.bridge = undefined
    this.controller = undefined
    this.bindings = undefined
    this.cursor = undefined
    this.credentialsValue = undefined
    this.phaseValue = 'stopped'
  }

  /** Retry a recoverable setup failure without waiting for the settings page. */
  private scheduleRetry(): void {
    if (this.retryTimer !== undefined || !this.recoverable || this.retries >= 12) return
    const delay = 5_000
    this.retries += 1
    const timer = setTimeout(() => {
      this.retryTimer = undefined
      if (!this.recoverable || this.phaseValue === 'stopped') return
      void this.start().catch(() => {})
    }, delay)
    // Do not keep a test or a quitting host alive for a retry.
    ;(timer as { unref?: () => void }).unref?.()
    this.retryTimer = timer
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }

  private async connect(credentials: WeixinCredentials): Promise<void> {
    if (this.controller === undefined || this.bindings === undefined || this.cursor === undefined) {
      return
    }
    const generation = this.generation
    this.credentialsValue = credentials
    try {
      await this.options.credentials.save(credentials)
    } catch (error) {
      // A token we cannot persist still works for this process; say so quietly.
      this.options.onError?.(error)
    }
    // Logout/stop while saving must win; the runtime may already be gone.
    if (this.generation !== generation) return
    const controller = this.controller
    const bindings = this.bindings
    const cursor = this.cursor
    if (controller === undefined || bindings === undefined || cursor === undefined) return
    this.adapter?.stop()
    const adapter = new WeixinAdapter({
      transport: this.transport,
      controller,
      bindings,
      credentials,
      capabilities: this.options.capabilities,
      cursor,
      ...(this.options.emptyPageDelayMs === undefined ? {} : { emptyPageDelayMs: this.options.emptyPageDelayMs }),
      refresh: () => this.bridge?.refreshSessions() ?? Promise.resolve(0),
      onError: error => this.options.onError?.(error),
      onFatal: error => {
        this.recoverable = false
        this.phaseValue = 'failed'
        this.errorValue = messageOf(error)
      },
    })
    this.adapter = adapter
    this.phaseValue = 'running'
    void adapter.run()
  }
}
