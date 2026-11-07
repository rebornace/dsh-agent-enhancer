import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import type { McpConnectorEntry, McpTransportConfig } from './types.ts'
import type { McpConnectorsStore } from './store.ts'

type McpClientModule = Plugin<Record<string, unknown>>

function toPluginConfig(entry: McpConnectorEntry): Record<string, unknown> {
  const base = {
    serverName: entry.serverName,
    failOnStartupError: false,
  }
  const transport = entry.transport
  if (transport.transport === 'stdio') {
    return {
      ...base,
      transport: 'stdio',
      command: transport.command,
      args: [...transport.args],
      env: { ...transport.env },
      cwd: transport.cwd,
    }
  }
  return {
    ...base,
    transport: 'streamable-http',
    url: transport.url,
    headers: { ...transport.headers },
  }
}

function transportEqual(a: McpTransportConfig, b: McpTransportConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface MountRecord {
  readonly fiber: Fiber
  readonly serverName: string
  readonly transport: McpTransportConfig
}

/**
 * Mounts one official `@deepseek-ai/dsh-mcp-client` fiber per enabled connector.
 */
export class McpConnectorRuntime {
  private readonly mounts = new Map<string, MountRecord>()
  private module: McpClientModule | null = null
  private bridgeError: string | null = null
  private featureEnabled = true

  constructor(
    private readonly ctx: Context,
    private readonly store: McpConnectorsStore,
  ) {}

  get bridgeAvailable(): boolean {
    return this.module !== null && this.bridgeError === null
  }

  get lastBridgeError(): string | null {
    return this.bridgeError
  }

  setFeatureEnabled(enabled: boolean): void {
    this.featureEnabled = enabled
  }

  async ensureBridge(): Promise<boolean> {
    if (this.module !== null) return true
    try {
      const loaded = await import('@deepseek-ai/dsh-mcp-client')
      if (typeof loaded.apply !== 'function') {
        this.bridgeError = '@deepseek-ai/dsh-mcp-client apply() missing'
        this.module = null
        return false
      }
      this.module = loaded as McpClientModule
      this.bridgeError = null
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.bridgeError = detail
      this.module = null
      this.ctx.logger.warn(`agent-enhancer: dsh-mcp-client unavailable: ${detail}`)
      return false
    }
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.mounts.keys()]
    for (const id of ids) {
      await this.disposeOne(id)
    }
  }

  private async disposeOne(id: string): Promise<void> {
    const record = this.mounts.get(id)
    if (record === undefined) return
    this.mounts.delete(id)
    try {
      await record.fiber.dispose()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-enhancer: dispose mcp connector ${id} failed: ${detail}`)
    }
  }

  private async mountOne(entry: McpConnectorEntry): Promise<void> {
    if (this.module === null) return
    const config = toPluginConfig(entry)
    try {
      const fiber = this.ctx.plugin(this.module, config)
      await fiber
      this.mounts.set(entry.id, {
        fiber,
        serverName: entry.serverName,
        transport: entry.transport,
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        `agent-enhancer: mount mcp connector ${entry.serverName} failed: ${detail}`,
      )
    }
  }

  /** Reconcile mounted fibers with the ledger (and feature gate). */
  async sync(): Promise<void> {
    if (!this.featureEnabled) {
      await this.disposeAll()
      return
    }
    const ok = await this.ensureBridge()
    if (!ok) {
      await this.disposeAll()
      return
    }

    const doc = this.store.load()
    const wanted = new Map(
      doc.connectors.filter(entry => entry.enabled).map(entry => [entry.id, entry]),
    )

    for (const id of [...this.mounts.keys()]) {
      const next = wanted.get(id)
      const current = this.mounts.get(id)
      if (next === undefined || current === undefined) {
        await this.disposeOne(id)
        continue
      }
      if (
        next.serverName !== current.serverName
        || !transportEqual(next.transport, current.transport)
      ) {
        await this.disposeOne(id)
      }
    }

    for (const [id, entry] of wanted) {
      if (this.mounts.has(id)) continue
      await this.mountOne(entry)
    }
  }
}
