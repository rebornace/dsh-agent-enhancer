import { AuxiliaryError } from '../../errors.ts'
import type { McpTransportConfig } from './types.ts'

/** Official dsh-mcp-client serverName pattern. */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

export function assertServerName(serverName: string): string {
  const trimmed = serverName.trim()
  if (!MCP_SERVER_NAME_PATTERN.test(trimmed)) {
    throw new AuxiliaryError(
      'FILE_EDIT_FAILED',
      `MCP serverName must match ${MCP_SERVER_NAME_PATTERN.source}`,
    )
  }
  return trimmed
}

export function assertTransport(transport: McpTransportConfig): McpTransportConfig {
  if (transport.transport === 'stdio') {
    const command = transport.command.trim()
    if (command === '') {
      throw new AuxiliaryError('FILE_EDIT_FAILED', 'stdio MCP connectors require a command')
    }
    return {
      transport: 'stdio',
      command,
      args: [...transport.args],
      env: { ...transport.env },
      cwd: transport.cwd.trim(),
    }
  }
  const url = transport.url.trim()
  if (url === '') {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'HTTP MCP connectors require a url')
  }
  try {
    void new URL(url)
  } catch {
    throw new AuxiliaryError('FILE_EDIT_FAILED', `Invalid MCP url: ${url}`)
  }
  return {
    transport: 'streamable-http',
    url,
    headers: { ...transport.headers },
  }
}

export function newConnectorId(): string {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
