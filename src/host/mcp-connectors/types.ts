/** MCP connector ledger + RPC types (enhancer-managed; mounts official dsh-mcp-client). */

export const MCP_CONNECTORS_VERSION = 1 as const

export type McpTransport = 'stdio' | 'streamable-http'

export type McpInstallChannel = 'manual' | 'npx' | 'github' | 'mcpJson'

export interface McpStdioConfig {
  readonly transport: 'stdio'
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

export interface McpHttpConfig {
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
}

export type McpTransportConfig = McpStdioConfig | McpHttpConfig

export interface McpConnectorEntry {
  readonly id: string
  readonly serverName: string
  readonly enabled: boolean
  readonly channel: McpInstallChannel
  readonly sourceLabel: string | null
  readonly transport: McpTransportConfig
  readonly createdAt: number
  readonly updatedAt: number
}

export interface McpConnectorsDocument {
  readonly version: typeof MCP_CONNECTORS_VERSION
  readonly connectors: readonly McpConnectorEntry[]
}

export interface McpConnectorsSnapshot {
  readonly connectors: readonly McpConnectorEntry[]
  readonly bridgeAvailable: boolean
  readonly bridgeError: string | null
}

export interface ListMcpConnectorsRequest {
  readonly unused?: never
}

export interface UpsertMcpConnectorRequest {
  readonly id?: string
  readonly serverName: string
  readonly enabled?: boolean
  readonly channel?: McpInstallChannel
  readonly sourceLabel?: string | null
  readonly transport: McpTransportConfig
}

export interface UpsertMcpConnectorResult {
  readonly connector: McpConnectorEntry
  readonly snapshot: McpConnectorsSnapshot
}

export interface SetMcpConnectorEnabledRequest {
  readonly id: string
  readonly enabled: boolean
}

export interface SetMcpConnectorEnabledResult {
  readonly connector: McpConnectorEntry
  readonly snapshot: McpConnectorsSnapshot
}

export interface UninstallMcpConnectorRequest {
  readonly id: string
}

export interface UninstallMcpConnectorResult {
  readonly id: string
  readonly snapshot: McpConnectorsSnapshot
}

export interface InstallMcpFromNpxRequest {
  readonly serverName: string
  readonly packageName: string
  readonly extraArgs?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly enabled?: boolean
  readonly force?: boolean
}

export interface InstallMcpFromNpxResult {
  readonly connector: McpConnectorEntry
  readonly snapshot: McpConnectorsSnapshot
}

export interface InstallMcpFromGitRequest {
  readonly serverName: string
  readonly source: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly enabled?: boolean
  readonly force?: boolean
}

export interface InstallMcpFromGitResult {
  readonly connector: McpConnectorEntry
  readonly snapshot: McpConnectorsSnapshot
}

export interface ImportMcpJsonRequest {
  readonly jsonText: string
  readonly enabled?: boolean
  readonly force?: boolean
}

export interface ImportMcpJsonResult {
  readonly imported: readonly McpConnectorEntry[]
  readonly skipped: readonly string[]
  readonly snapshot: McpConnectorsSnapshot
}

export interface ListMcpConnectorToolsRequest {
  readonly serverName: string
}

export interface McpConnectorToolInfo {
  readonly name: string
  readonly description: string
}

export interface ListMcpConnectorToolsResult {
  readonly serverName: string
  readonly tools: readonly McpConnectorToolInfo[]
}
