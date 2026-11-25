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
      ...(this.credentialsValue?.botId === undefined ? {} : { botId: this.credentialsValue.botId }),
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
    }
  }

  async start(): Promise<RuntimeStatus> {
    if (this.phaseValue !== 'stopped') return this.status()
    this.errorValue = undefined
    this.bindings = new BindingStore({
      filePath: join(this.options.rootDir, 'bindings.json'),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    this.cursor = createCursorStore({ filePath: join(this.options.rootDir, 'cursor.json') })
    const ports = createHostPorts(this.options.ctx, { setPaused: this.options.setPaused })
    this.controller = new RemoteController({
      actions: {
        sendPrompt: (sessionId, text) => ports.prompt(sessionId, text, 'queue'),
        setPaused: this.options.setPaused,
        stop: sessionId => ports.cancel(sessionId),
      },
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    this.bridge = installRemoteHostBridge(this.options.ctx, {
      ports,
      capabilities: this.options.capabilities,
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
    })
    try {
      await this.bridge.refreshSessions()
    } catch (error) {
      this.phaseValue = 'failed'
      this.errorValue = messageOf(error)
      return this.status()
    }
    const stored = await this.options.credentials.load().catch(() => undefined)
    if (stored !== undefined) {
      await this.connect(stored)
    } else {
      this.phaseValue = 'unbound'
    }
    return this.status()
  }

  /** Start a fresh QR login; connecting happens when the scan is confirmed. */
  async beginLogin(): Promise<LoginTicket> {
    if (this.phaseValue === 'stopped') await this.start()
    const ticket = await this.login.begin()
    void this.login.wait().then(credentials => {
      if (credentials !== undefined) void this.connect(credentials)
    })
    return ticket
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

  private async connect(credentials: WeixinCredentials): Promise<void> {
    if (this.controller === undefined || this.bindings === undefined || this.cursor === undefined) {
      return
    }
    this.credentialsValue = credentials
    try {
      await this.options.credentials.save(credentials)
    } catch (error) {
      // A token we cannot persist still works for this process; say so quietly.
      this.options.onError?.(error)
    }
    this.adapter?.stop()
    const adapter = new WeixinAdapter({
      transport: this.transport,
      controller: this.controller,
      bindings: this.bindings,
      credentials,
      capabilities: this.options.capabilities,
      cursor: this.cursor,
      ...(this.options.emptyPageDelayMs === undefined ? {} : { emptyPageDelayMs: this.options.emptyPageDelayMs }),
      onError: error => this.options.onError?.(error),
      onFatal: error => {
        this.phaseValue = 'failed'
        this.errorValue = messageOf(error)
      },
    })
    this.adapter = adapter
    this.phaseValue = 'running'
    void adapter.run()
  }
}
