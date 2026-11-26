import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { BindingStore, RemoteChannel } from '../bindings.ts'
import type { ChannelDevice, ChannelPhase, ChannelStatus } from '../channels/status.ts'
import type { RemoteController } from '../controller.ts'
import { splitForChannel } from '../render.ts'
import type { ChannelCapabilities } from '../types.ts'
import { WeixinAdapter } from './adapter.ts'
import { createCursorStore } from './cursor.ts'
import type { CursorStore } from './cursor.ts'
import type { WeixinCredentialStore } from './credentials.ts'
import { WeixinLogin } from './login.ts'
import type { LoginSnapshot } from './login.ts'
import { WeixinTransport } from './transport.ts'
import type { LoginTicket, WeixinCredentials } from './transport.ts'

export interface WeixinChannelOptions {
  readonly ctx: Context
  readonly rootDir: string
  readonly capabilities: ChannelCapabilities
  readonly credentials: WeixinCredentialStore
  readonly bindings: BindingStore
  readonly controller: RemoteController
  readonly refresh: () => Promise<unknown>
  readonly createTransport?: () => WeixinTransport
  readonly now?: () => number
  readonly onError?: (error: unknown) => void
  readonly emptyPageDelayMs?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** WeChat: QR login, binding, the poll loop and the bot credential. */
export class WeixinChannel {
  readonly id: RemoteChannel = 'weixin'
  private readonly transport: WeixinTransport
  private readonly login: WeixinLogin
  private adapter: WeixinAdapter | undefined
  private cursor: CursorStore | undefined
  private credentialsValue: WeixinCredentials | undefined
  private phaseValue: ChannelPhase = 'off'
  private errorValue: string | undefined
  /** Bumped by stop/logout so an in-flight scan result cannot reconnect. */
  private generation = 0

  constructor(private readonly options: WeixinChannelOptions) {
    this.transport = options.createTransport?.() ?? new WeixinTransport()
    this.login = new WeixinLogin({ transport: this.transport })
  }

  get running(): boolean {
    return this.phaseValue === 'running'
  }

  status(): ChannelStatus {
    const devices: ChannelDevice[] = (this.options.bindings.list())
      .filter(binding => binding.channel === this.id)
      .map(binding => ({ chatId: binding.chatId, boundAt: binding.boundAt }))
    return {
      id: this.id,
      phase: this.phaseValue,
      login: this.login.snapshot(),
      devices,
      ...(this.credentialsValue?.botId === undefined ? {} : { handle: this.credentialsValue.botId }),
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
    }
  }

  async start(): Promise<void> {
    if (this.phaseValue === 'running' || this.phaseValue === 'unbound') return
    this.cursor = createCursorStore({ filePath: join(this.options.rootDir, 'cursor.json') })
    const stored = await this.options.credentials.load().catch(() => undefined)
    if (stored === undefined) {
      this.phaseValue = 'unbound'
      return
    }
    await this.connect(stored)
  }

  /** Start a fresh QR login; connecting happens when the scan is confirmed. */
  async beginLogin(): Promise<LoginTicket> {
    if (this.phaseValue === 'off' || this.phaseValue === 'failed') await this.start()
    const generation = this.generation
    const ticket = await this.login.begin()
    void this.login.wait().then(credentials => {
      if (credentials !== undefined && this.generation === generation) void this.connect(credentials)
    })
    return ticket
  }

  cancelLogin(): void {
    this.login.cancel()
    if (this.phaseValue === 'unbound' || this.phaseValue === 'failed') {
      this.errorValue = undefined
      this.phaseValue = 'unbound'
    }
  }

  async logout(): Promise<void> {
    this.generation += 1
    this.adapter?.stop()
    this.adapter = undefined
    this.login.cancel()
    this.credentialsValue = undefined
    this.errorValue = undefined
    await this.options.credentials.clear().catch(error => {
      this.options.onError?.(error)
    })
    if (this.phaseValue !== 'off') this.phaseValue = 'unbound'
  }

  stop(): void {
    this.generation += 1
    this.adapter?.stop()
    this.login.cancel()
    this.adapter = undefined
    this.cursor = undefined
    this.credentialsValue = undefined
    this.phaseValue = 'off'
  }

  /** Push a ready-made text; used for notices, not command replies. */
  async send(chatId: string, text: string): Promise<void> {
    const credentials = this.credentialsValue
    const adapter = this.adapter
    if (this.phaseValue !== 'running' || credentials === undefined || adapter === undefined) return
    const chunks = splitForChannel(text, this.options.capabilities.maxChars)
    for (const chunk of chunks) {
      const contextToken = adapter.contextFor(chatId)
      await this.transport.sendText(
        credentials,
        chatId,
        chunk,
        contextToken === undefined ? {} : { contextToken },
      )
    }
  }

  contextFor(chatId: string): string | undefined {
    return this.adapter?.contextFor(chatId)
  }

  private async connect(credentials: WeixinCredentials): Promise<void> {
    const generation = this.generation
    this.credentialsValue = credentials
    try {
      await this.options.credentials.save(credentials)
    } catch (error) {
      // A token we cannot persist still works for this process; say so quietly.
      this.options.onError?.(error)
    }
    if (this.generation !== generation) return
    const cursor = this.cursor
    if (cursor === undefined) return
    this.adapter?.stop()
    const adapter = new WeixinAdapter({
      transport: this.transport,
      controller: this.options.controller,
      bindings: this.options.bindings,
      credentials,
      capabilities: this.options.capabilities,
      cursor,
      refresh: this.options.refresh,
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
