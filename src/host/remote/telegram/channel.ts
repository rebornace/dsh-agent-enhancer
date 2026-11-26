import { join } from 'node:path'
import type { BindingStore, RemoteChannel } from '../bindings.ts'
import { createCursorStore } from '../channels/cursor.ts'
import type { CursorStore } from '../channels/cursor.ts'
import type { ChannelDevice, ChannelPhase, ChannelStatus } from '../channels/status.ts'
import type { RemoteController } from '../controller.ts'
import { splitForChannel } from '../render.ts'
import type { ChannelCapabilities } from '../types.ts'
import { TelegramAdapter } from './adapter.ts'
import type { TelegramCredentialStore } from './credentials.ts'
import { TelegramTransport } from './transport.ts'
import type { TelegramCredentials } from './transport.ts'

export interface TelegramChannelOptions {
  readonly rootDir: string
  readonly capabilities: ChannelCapabilities
  readonly credentials: TelegramCredentialStore
  readonly bindings: BindingStore
  readonly controller: RemoteController
  readonly refresh: () => Promise<unknown>
  readonly createTransport?: () => TelegramTransport
  readonly onError?: (error: unknown) => void
  readonly emptyPageDelayMs?: number
}

export interface TelegramConnectResult {
  readonly ok: boolean
  readonly username?: string
  readonly error?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Telegram: token login, binding, the poll loop and the bot credential. */
export class TelegramChannel {
  readonly id: RemoteChannel = 'telegram'
  private readonly transport: TelegramTransport
  private adapter: TelegramAdapter | undefined
  private cursor: CursorStore | undefined
  private credentialsValue: TelegramCredentials | undefined
  private phaseValue: ChannelPhase = 'off'
  private errorValue: string | undefined
  private generation = 0

  constructor(private readonly options: TelegramChannelOptions) {
    this.transport = options.createTransport?.() ?? new TelegramTransport()
  }

  get running(): boolean {
    return this.phaseValue === 'running'
  }

  status(): ChannelStatus {
    const devices: ChannelDevice[] = this.options.bindings.list()
      .filter(binding => binding.channel === this.id)
      .map(binding => ({ chatId: binding.chatId, boundAt: binding.boundAt }))
    const connected = this.phaseValue === 'running'
    const failed = this.phaseValue === 'failed'
    return {
      id: this.id,
      phase: this.phaseValue,
      login: {
        phase: connected ? 'connected' : failed ? 'failed' : 'idle',
        status: connected ? 'connected' : failed ? 'failed' : 'idle',
        ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
      },
      devices,
      ...(this.credentialsValue?.username === undefined
        ? (this.credentialsValue?.botId === undefined ? {} : { handle: this.credentialsValue.botId })
        : { handle: `@${this.credentialsValue.username}` }),
      ...(this.errorValue === undefined ? {} : { error: this.errorValue }),
    }
  }

  async start(): Promise<void> {
    if (this.phaseValue === 'running' || this.phaseValue === 'unbound') return
    const stored = await this.options.credentials.load().catch(() => undefined)
    if (stored === undefined) {
      this.phaseValue = 'unbound'
      return
    }
    this.connectStored(stored)
  }

  /** Validate and switch to a new bot token. */
  async connect(token: string): Promise<TelegramConnectResult> {
    const trimmed = token.trim()
    if (trimmed === '') return { ok: false, error: '请填写 Bot Token' }
    const generation = this.generation
    let identity: { id: string; username?: string }
    try {
      identity = await this.transport.validate({ token: trimmed })
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (this.generation !== generation) return { ok: false, error: '连接已取消' }
    const credentials: TelegramCredentials = {
      token: trimmed,
      botId: identity.id,
      ...(identity.username === undefined ? {} : { username: identity.username }),
    }
    try {
      await this.options.credentials.save(credentials)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (this.generation !== generation) return { ok: false, error: '连接已取消' }
    this.connectStored(credentials)
    return { ok: true, ...(identity.username === undefined ? {} : { username: identity.username }) }
  }

  async logout(): Promise<void> {
    this.generation += 1
    this.adapter?.stop()
    this.adapter = undefined
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
    this.adapter = undefined
    this.cursor = undefined
    this.credentialsValue = undefined
    this.phaseValue = 'off'
  }

  async send(
    chatId: string,
    text: string,
    buttons?: readonly { readonly label: string; readonly command: string }[],
  ): Promise<void> {
    const credentials = this.credentialsValue
    if (this.phaseValue !== 'running' || credentials === undefined) return
    const chunks = splitForChannel(text, this.options.capabilities.maxChars)
    for (const [index, chunk] of chunks.entries()) {
      // Buttons belong to the last chunk so a split card does not duplicate them.
      await this.transport.sendText(
        credentials,
        chatId,
        chunk,
        index === chunks.length - 1 && buttons !== undefined && buttons.length > 0 ? { buttons } : {},
      )
    }
  }

  contextFor(_chatId: string): string | undefined {
    return undefined
  }

  private connectStored(credentials: TelegramCredentials): void {
    this.cursor ??= createCursorStore({ filePath: join(this.options.rootDir, 'telegram-cursor.json') })
    this.credentialsValue = credentials
    this.errorValue = undefined
    this.adapter?.stop()
    const adapter = new TelegramAdapter({
      transport: this.transport,
      credentials,
      controller: this.options.controller,
      bindings: this.options.bindings,
      capabilities: this.options.capabilities,
      cursor: this.cursor,
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
