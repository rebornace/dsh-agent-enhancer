import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis'
import { rewriteMcpProbeFailure } from './probe-message.ts'
import type { McpConnectorsStore } from './store.ts'
import {
  disabledMcpStatus,
  summarizeMcpConnectionStatus,
  type McpConnectionStatusLike,
} from './status.ts'
import type {
  McpConnectorEntry,
  McpConnectorRuntimeStatus,
  McpConnectorStatusRow,
  McpTransportConfig,
  ProbeMcpConnectorResult,
} from './types.ts'

type McpClientModule = Plugin<Record<string, unknown>>

type McpStatusHandle = {
  readonly current: () => McpConnectionStatusLike
}

type McpProbeOutcome = {
  readonly ok: boolean
  readonly message?: string
  readonly stage?: string
  readonly serverInfo?: { readonly name: string; readonly version: string }
  readonly toolNames?: readonly string[]
  readonly truncated?: boolean
  readonly durationMs?: number
}

type McpClientApi = {
  readonly connectionStatusOf?: (fiber: Fiber) => McpStatusHandle | undefined
  readonly probeServer?: (
    ctx: Context,
    config: Record<string, unknown>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ) => Promise<McpProbeOutcome>
}

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
 * Status / restart / probe use official mcp-client APIs (same surface as mcp-manager).
 */
export class McpConnectorRuntime {
  private readonly mounts = new Map<string, MountRecord>()
  private module: McpClientModule | null = null
  private clientApi: McpClientApi | null = null
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
      const loaded = await import('@deepseek-ai/dsh-mcp-client') as McpClientApi & McpClientModule
      if (typeof (loaded as { apply?: unknown }).apply !== 'function') {
        this.bridgeError = '@deepseek-ai/dsh-mcp-client apply() missing'
        this.module = null
        this.clientApi = null
        return false
      }
      this.module = loaded as McpClientModule
      this.clientApi = loaded
      this.bridgeError = null
      return true
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.bridgeError = detail
      this.module = null
      this.clientApi = null
      this.ctx.logger.warn(`agent-enhancer: dsh-mcp-client unavailable: ${detail}`)
      return false
    }
  }

  statusOf(id: string, entry?: McpConnectorEntry): McpConnectorRuntimeStatus {
    const connector = entry ?? this.store.load().connectors.find(row => row.id === id)
    if (connector === undefined) {
      return summarizeMcpConnectionStatus(undefined)
    }
    if (!connector.enabled || !this.featureEnabled) {
      return disabledMcpStatus()
    }
    const mount = this.mounts.get(id)
    if (mount === undefined) {
      return summarizeMcpConnectionStatus(undefined)
    }
    try {
      const handle = this.clientApi?.connectionStatusOf?.(mount.fiber)
      return summarizeMcpConnectionStatus(handle?.current())
    } catch {
      return summarizeMcpConnectionStatus(undefined)
    }
  }

  statusRows(): readonly McpConnectorStatusRow[] {
    return this.store.load().connectors.map(entry => ({
      id: entry.id,
      status: this.statusOf(entry.id, entry),
    }))
  }

  async restart(id: string): Promise<{ readonly ok: boolean; readonly error: string | null }> {
    const entry = this.store.load().connectors.find(row => row.id === id)
    if (entry === undefined) {
      return { ok: false, error: `MCP connector not found: ${id}` }
    }
    if (!entry.enabled) {
      return { ok: false, error: 'Connector is disabled' }
    }
    if (!this.featureEnabled) {
      return { ok: false, error: 'MCP connectors feature is disabled' }
    }
    const ok = await this.ensureBridge()
    if (!ok) {
      return { ok: false, error: this.bridgeError ?? 'mcp-client bridge unavailable' }
    }
    await this.disposeOne(id)
    await this.mountOne(entry)
    if (!this.mounts.has(id)) {
      return { ok: false, error: 'Restart failed to remount connector' }
    }
    return { ok: true, error: null }
  }

  async probe(
    id: string,
    signal?: AbortSignal,
  ): Promise<Omit<ProbeMcpConnectorResult, 'snapshot'>> {
    const entry = this.store.load().connectors.find(row => row.id === id)
    if (entry === undefined) {
      return {
        id,
        ok: false,
        message: `MCP connector not found: ${id}`,
        toolNames: [],
        truncated: false,
        durationMs: 0,
      }
    }

    // Prefer the live fiber when already connected. Gateways like ModelScope
    // issue session / signed URLs that reject a second handshake ("Url is expired")
    // even while the mounted instance still works.
    const live = this.statusOf(id, entry)
    if (live.state === 'connected') {
      const toolNames = this.liveToolNames(entry.serverName)
      const count = live.toolCount ?? toolNames.length
      return {
        id,
        ok: true,
        message: `live · ${count} tools`,
        toolNames,
        truncated: false,
        durationMs: 0,
      }
    }

    const ok = await this.ensureBridge()
    if (!ok || this.clientApi?.probeServer === undefined) {
      return {
        id,
        ok: false,
        message: this.bridgeError ?? 'mcp-client probeServer unavailable',
        toolNames: [],
        truncated: false,
        durationMs: 0,
      }
    }
    try {
      const result = await this.clientApi.probeServer(this.ctx, toPluginConfig(entry), {
        timeoutMs: 15_000,
        ...(signal === undefined ? {} : { signal }),
      })
      if (result.ok) {
        const toolNames = result.toolNames ?? []
        return {
          id,
          ok: true,
          message: result.serverInfo === undefined
            ? `ok · ${toolNames.length} tools`
            : `ok · ${result.serverInfo.name}@${result.serverInfo.version} · ${toolNames.length} tools`,
          toolNames,
          truncated: result.truncated === true,
          durationMs: result.durationMs ?? 0,
        }
      }
      const raw = `${result.stage ?? 'probe'}: ${result.message ?? 'failed'}`
      return {
        id,
        ok: false,
        message: rewriteMcpProbeFailure(raw),
        toolNames: [],
        truncated: false,
        durationMs: result.durationMs ?? 0,
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        id,
        ok: false,
        message: rewriteMcpProbeFailure(detail),
        toolNames: [],
        truncated: false,
        durationMs: 0,
      }
    }
  }

  private liveToolNames(serverName: string): readonly string[] {
    const prefix = `mcp__${serverName}__`
    try {
      const definitions = this.ctx.tools.definitions() as readonly {
        readonly name: string
      }[]
      return definitions
        .filter(def => def.name.startsWith(prefix))
        .map(def => def.name.slice(prefix.length))
        .filter(name => name.length > 0)
    } catch {
      return []
    }
  }

  async disposeAll(): Promise<void> {
    const ids = [...this.mounts.keys()]
    for (const nextId of ids) {
      await this.disposeOne(nextId)
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
