import { AuxiliaryError } from '../../errors.ts'
import type { McpTransportConfig } from './types.ts'
import { assertServerName, assertTransport } from './validate.ts'

export interface ParsedMcpJsonServer {
  readonly serverName: string
  readonly transport: McpTransportConfig
  readonly sourceLabel: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

function parseOneServer(name: string, raw: unknown): ParsedMcpJsonServer {
  if (!isRecord(raw)) {
    throw new AuxiliaryError('FILE_EDIT_FAILED', `mcpServers.${name} must be an object`)
  }
  const serverName = assertServerName(name)
  if (typeof raw.url === 'string' && raw.url.trim() !== '') {
    const transport = assertTransport({
      transport: 'streamable-http',
      url: raw.url,
      headers: parseStringRecord(raw.headers),
    })
    return {
      serverName,
      transport,
      sourceLabel: `mcp.json:${serverName}`,
    }
  }
  if (typeof raw.command === 'string' && raw.command.trim() !== '') {
    const args = Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === 'string')
      : []
    const transport = assertTransport({
      transport: 'stdio',
      command: raw.command,
      args,
      env: parseStringRecord(raw.env),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    })
    return {
      serverName,
      transport,
      sourceLabel: `mcp.json:${serverName}`,
    }
  }
  throw new AuxiliaryError(
    'FILE_EDIT_FAILED',
    `mcpServers.${name} needs command+args or url`,
  )
}

/**
 * Parse Cursor / Claude Desktop style `{ "mcpServers": { name: {...} } }`.
 */
export function parseMcpJsonText(jsonText: string): readonly ParsedMcpJsonServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuxiliaryError('FILE_EDIT_FAILED', `Invalid mcp.json: ${detail}`)
  }
  if (!isRecord(parsed)) {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'mcp.json root must be an object')
  }
  const servers = parsed.mcpServers
  if (!isRecord(servers)) {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'mcp.json must contain mcpServers object')
  }
  const out: ParsedMcpJsonServer[] = []
  for (const [name, raw] of Object.entries(servers)) {
    out.push(parseOneServer(name, raw))
  }
  if (out.length === 0) {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'mcp.json has no servers')
  }
  return out
}
