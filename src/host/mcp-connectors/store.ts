import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  MCP_CONNECTORS_VERSION,
  type McpConnectorEntry,
  type McpConnectorsDocument,
  type McpInstallChannel,
  type McpTransportConfig,
} from './types.ts'
import { mcpConnectorsLedgerPath } from './paths.ts'

export interface McpConnectorsStore {
  readonly rootDir: string
  load(): McpConnectorsDocument
  save(connectors: readonly McpConnectorEntry[]): McpConnectorsDocument
}

function emptyDoc(): McpConnectorsDocument {
  return { version: MCP_CONNECTORS_VERSION, connectors: [] }
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

function parseTransport(raw: unknown): McpTransportConfig | null {
  if (!isRecord(raw)) return null
  const transport = raw.transport
  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') return null
    const args = Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === 'string')
      : []
    return {
      transport: 'stdio',
      command: raw.command.trim(),
      args,
      env: parseStringRecord(raw.env),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    }
  }
  if (transport === 'streamable-http') {
    if (typeof raw.url !== 'string' || raw.url.trim() === '') return null
    return {
      transport: 'streamable-http',
      url: raw.url.trim(),
      headers: parseStringRecord(raw.headers),
    }
  }
  return null
}

const CHANNELS: readonly McpInstallChannel[] = ['manual', 'npx', 'github', 'mcpJson']

function parseChannel(value: unknown): McpInstallChannel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
    ? value as McpInstallChannel
    : 'manual'
}

function parseEntry(raw: unknown): McpConnectorEntry | null {
  if (!isRecord(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  if (typeof raw.serverName !== 'string' || raw.serverName.trim() === '') return null
  const transport = parseTransport(raw.transport)
  if (transport === null) return null
  return {
    id: raw.id.trim(),
    serverName: raw.serverName.trim(),
    enabled: raw.enabled !== false,
    channel: parseChannel(raw.channel),
    sourceLabel: typeof raw.sourceLabel === 'string' ? raw.sourceLabel : null,
    transport,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  }
}

function parseDoc(raw: string): McpConnectorsDocument {
  try {
    const parsed = JSON.parse(raw) as Partial<McpConnectorsDocument>
    if (parsed.version !== MCP_CONNECTORS_VERSION || !Array.isArray(parsed.connectors)) {
      return emptyDoc()
    }
    const connectors: McpConnectorEntry[] = []
    for (const entry of parsed.connectors) {
      const next = parseEntry(entry)
      if (next !== null) connectors.push(next)
    }
    return { version: MCP_CONNECTORS_VERSION, connectors }
  } catch {
    return emptyDoc()
  }
}

export function createMcpConnectorsStore(rootDir: string): McpConnectorsStore {
  mkdirSync(rootDir, { recursive: true })
  const file = mcpConnectorsLedgerPath(rootDir)

  return {
    rootDir,
    load(): McpConnectorsDocument {
      try {
        return parseDoc(readFileSync(file, 'utf8'))
      } catch (error) {
        const code = error !== null && typeof error === 'object'
          ? String(Reflect.get(error, 'code') ?? '')
          : ''
        if (code !== 'ENOENT') {
          // Corrupt or unreadable → empty rather than crash host boot.
        }
        return emptyDoc()
      }
    },
    save(connectors: readonly McpConnectorEntry[]): McpConnectorsDocument {
      const doc: McpConnectorsDocument = {
        version: MCP_CONNECTORS_VERSION,
        connectors: [...connectors],
      }
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
      return doc
    },
  }
}
