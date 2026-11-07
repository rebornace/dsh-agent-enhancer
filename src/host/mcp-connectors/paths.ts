import { join } from 'node:path'
import { PACKAGE_NAME } from '../../identity.ts'

/** Ledger + cloned MCP server trees under plugin-data. */
export function mcpConnectorsRoot(pluginDataPackageRoot: string): string {
  return join(pluginDataPackageRoot, 'mcp-connectors')
}

export function mcpConnectorsLedgerPath(root: string): string {
  return join(root, 'mcp-connectors.json')
}

export function mcpServersRoot(root: string): string {
  return join(root, 'mcp-servers')
}

export function mcpServerInstallDir(root: string, id: string): string {
  return join(mcpServersRoot(root), id)
}

/** Resolve default plugin-data package root for desktop profile. */
export function defaultPluginDataPackageRoot(dshHome: string): string {
  return join(dshHome, 'profiles', 'desktop', 'plugin-data', PACKAGE_NAME)
}
