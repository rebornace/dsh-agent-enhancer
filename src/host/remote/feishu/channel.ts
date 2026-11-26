import type { BindingStore, RemoteChannel } from '../bindings.ts'
import type { ChannelDevice, ChannelPhase, ChannelStatus } from '../channels/status.ts'
import type { RemoteController } from '../controller.ts'
import { splitForChannel } from '../render.ts'
import type { ChannelCapabilities } from '../types.ts'
import { FeishuAdapter } from './adapter.ts'
import type { FeishuCredentialStore } from './credentials.ts'
import { FeishuTransport } from './transport.ts'
import type { FeishuCredentials } from './transport.ts'

export interface FeishuChannelOptions {
  readonly capabilities: ChannelCapabilities
  readonly credentials: FeishuCredentialStore
  readonly bindings: BindingStore
  readonly controller: RemoteController
  readonly refresh: () => Promise<unknown>
  readonly createTransport?: () => FeishuTransport
  readonly onError?: (error: unknown) => void
  readonly emptyPageDelayMs?: number
}

export interface FeishuConnectResult {
  readonly ok: boolean
  readonly name?: string
  readonly error?: string
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Feishu: app-credential login, the long connection, binding and the poll loop. */
export class FeishuChannel {
  readonly id: RemoteChannel = 'feishu'
  private readonly transport: FeishuTransport
  private adapter: FeishuAdapter | undefined
  private credentialsValue: FeishuCredentials | undefined
  private phaseValue: ChannelPhase = 'off'
  private errorValue: string | undefined
  private generation = 0

  constructor(private readonly options: FeishuChannelOptions) {
    this.transport = options.createTransport?.() ?? new FeishuTransport()
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
      ...(this.credentialsValue?.name === undefined ? {} : { handle: this.credentialsValue.name }),
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

  /** Validate the app credentials, then keep the long connection open. */
  async connect(appId: string, appSecret: string): Promise<FeishuConnectResult> {
    const id = appId.trim()
    const secret = appSecret.trim()
    if (id === '' || secret === '') return { ok: false, error: '请填写 App ID 和 App Secret' }
    const generation = this.generation
    let identity: { name?: string }
    try {
      identity = await this.transport.validate({ appId: id, appSecret: secret })
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (this.generation !== generation) return { ok: false, error: '连接已取消' }
    const credentials: FeishuCredentials = {
      appId: id,
      appSecret: secret,
      ...(identity.name === undefined ? {} : { name: identity.name }),
    }
    try {
      await this.options.credentials.save(credentials)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    if (this.generation !== generation) return { ok: false, error: '连接已取消' }
    this.connectStored(credentials)
    return { ok: true, ...(identity.name === undefined ? {} : { name: identity.name }) }
  }

  async logout(): Promise<void> {
    this.generation += 1
    this.adapter?.stop()
    this.adapter = undefined
    this.transport.stop()
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
    this.transport.stop()
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

  private connectStored(credentials: FeishuCredentials): void {
    this.credentialsValue = credentials
    this.errorValue = undefined
    this.adapter?.stop()
    const generation = this.generation
    const adapter = new FeishuAdapter({
      transport: this.transport,
      credentials,
      controller: this.options.controller,
      bindings: this.options.bindings,
      capabilities: this.options.capabilities,
      refresh: this.options.refresh,
      ...(this.options.emptyPageDelayMs === undefined ? {} : { emptyPageDelayMs: this.options.emptyPageDelayMs }),
      onError: error => this.options.onError?.(error),
      onFatal: error => {
        this.phaseValue = 'failed'
        this.errorValue = messageOf(error)
      },
    })
    this.adapter = adapter
    this.phaseValue = 'off'
    void this.transport.start(credentials).then(() => {
      if (this.generation !== generation) return
      this.phaseValue = 'running'
      this.errorValue = undefined
      void adapter.run()
    }).catch(error => {
      if (this.generation !== generation) return
      this.adapter = undefined
      adapter.stop()
      this.phaseValue = 'failed'
      this.errorValue = `飞书长连接没有建立：${messageOf(error)}`
    })
  }
}
