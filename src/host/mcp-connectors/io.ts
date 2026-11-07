import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { AuxiliaryError } from '../../errors.ts'
import { removePathRobust } from '../instructions-skills/remove-path.ts'
import { parseMcpJsonText } from './import-mcp-json.ts'
import { installMcpServerFromGit } from './install-git.ts'
import { mcpServerInstallDir } from './paths.ts'
import type { McpConnectorRuntime } from './runtime.ts'
import type { McpConnectorsStore } from './store.ts'
import type {
  ImportMcpJsonRequest,
  ImportMcpJsonResult,
  InstallMcpFromGitRequest,
  InstallMcpFromGitResult,
  InstallMcpFromNpxRequest,
  InstallMcpFromNpxResult,
  ListMcpConnectorToolsRequest,
  ListMcpConnectorToolsResult,
  McpConnectorEntry,
  McpConnectorsSnapshot,
  SetMcpConnectorEnabledRequest,
  SetMcpConnectorEnabledResult,
  UninstallMcpConnectorRequest,
  UninstallMcpConnectorResult,
  UpsertMcpConnectorRequest,
  UpsertMcpConnectorResult,
} from './types.ts'
import { assertServerName, assertTransport, newConnectorId } from './validate.ts'

export interface McpConnectorsHost {
  readonly ctx: Context
  readonly store: McpConnectorsStore
  readonly runtime: McpConnectorRuntime
}

function snapshotOf(host: McpConnectorsHost): McpConnectorsSnapshot {
  return {
    connectors: host.store.load().connectors,
    bridgeAvailable: host.runtime.bridgeAvailable,
    bridgeError: host.runtime.lastBridgeError,
  }
}

function findByServerName(
  connectors: readonly McpConnectorEntry[],
  serverName: string,
  exceptId?: string,
): McpConnectorEntry | undefined {
  return connectors.find(
    entry => entry.serverName === serverName && entry.id !== exceptId,
  )
}

async function persistAndSync(
  host: McpConnectorsHost,
  connectors: readonly McpConnectorEntry[],
): Promise<McpConnectorsSnapshot> {
  host.store.save(connectors)
  await host.runtime.sync()
  return snapshotOf(host)
}

export async function listMcpConnectorsNow(
  host: McpConnectorsHost,
): Promise<McpConnectorsSnapshot> {
  await host.runtime.ensureBridge()
  // Keep mounts aligned with ledger on every list.
  await host.runtime.sync()
  return snapshotOf(host)
}

export async function upsertMcpConnectorNow(
  host: McpConnectorsHost,
  request: UpsertMcpConnectorRequest,
): Promise<UpsertMcpConnectorResult> {
  const serverName = assertServerName(request.serverName)
  const transport = assertTransport(request.transport)
  const now = Date.now()
  const doc = host.store.load()
  const existing = request.id !== undefined
    ? doc.connectors.find(entry => entry.id === request.id)
    : undefined

  if (request.id !== undefined && existing === undefined) {
    throw new AuxiliaryError('FILE_NOT_FOUND', `MCP connector not found: ${request.id}`)
  }

  const clash = findByServerName(doc.connectors, serverName, existing?.id)
  if (clash !== undefined) {
    throw new AuxiliaryError(
      'FILE_EDIT_FAILED',
      `serverName "${serverName}" is already used by another connector`,
    )
  }

  const connector: McpConnectorEntry = existing !== undefined
    ? {
      ...existing,
      serverName,
      enabled: request.enabled ?? existing.enabled,
      channel: request.channel ?? existing.channel,
      sourceLabel: request.sourceLabel !== undefined ? request.sourceLabel : existing.sourceLabel,
      transport,
      updatedAt: now,
    }
    : {
      id: newConnectorId(),
      serverName,
      enabled: request.enabled !== false,
      channel: request.channel ?? 'manual',
      sourceLabel: request.sourceLabel ?? null,
      transport,
      createdAt: now,
      updatedAt: now,
    }

  const next = existing !== undefined
    ? doc.connectors.map(entry => entry.id === connector.id ? connector : entry)
    : [...doc.connectors, connector]

  const snapshot = await persistAndSync(host, next)
  return { connector, snapshot }
}

export async function setMcpConnectorEnabledNow(
  host: McpConnectorsHost,
  request: SetMcpConnectorEnabledRequest,
): Promise<SetMcpConnectorEnabledResult> {
  const doc = host.store.load()
  const existing = doc.connectors.find(entry => entry.id === request.id)
  if (existing === undefined) {
    throw new AuxiliaryError('FILE_NOT_FOUND', `MCP connector not found: ${request.id}`)
  }
  const connector: McpConnectorEntry = {
    ...existing,
    enabled: request.enabled,
    updatedAt: Date.now(),
  }
  const next = doc.connectors.map(entry => entry.id === connector.id ? connector : entry)
  const snapshot = await persistAndSync(host, next)
  return { connector, snapshot }
}

export async function uninstallMcpConnectorNow(
  host: McpConnectorsHost,
  request: UninstallMcpConnectorRequest,
): Promise<UninstallMcpConnectorResult> {
  const doc = host.store.load()
  const existing = doc.connectors.find(entry => entry.id === request.id)
  if (existing === undefined) {
    throw new AuxiliaryError('FILE_NOT_FOUND', `MCP connector not found: ${request.id}`)
  }
  const next = doc.connectors.filter(entry => entry.id !== request.id)
  const installDir = mcpServerInstallDir(host.store.rootDir, request.id)
  if (existsSync(installDir)) {
    try {
      removePathRobust(installDir)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      host.ctx.logger.warn(`agent-enhancer: remove mcp server dir failed: ${detail}`)
    }
  }
  const snapshot = await persistAndSync(host, next)
  return { id: request.id, snapshot }
}

export async function installMcpFromNpxNow(
  host: McpConnectorsHost,
  request: InstallMcpFromNpxRequest,
): Promise<InstallMcpFromNpxResult> {
  const serverName = assertServerName(request.serverName)
  const packageName = request.packageName.trim()
  if (packageName === '') {
    throw new AuxiliaryError('FILE_EDIT_FAILED', 'npx package name is required')
  }
  const doc = host.store.load()
  const clash = findByServerName(doc.connectors, serverName)
  if (clash !== undefined) {
    if (request.force !== true) {
      throw new AuxiliaryError(
        'FILE_EDIT_FAILED',
        `serverName "${serverName}" already exists (pass force to replace)`,
      )
    }
    await uninstallMcpConnectorNow(host, { id: clash.id })
  }

  const args = ['-y', packageName, ...(request.extraArgs ?? [])]
  return upsertMcpConnectorNow(host, {
    serverName,
    enabled: request.enabled !== false,
    channel: 'npx',
    sourceLabel: packageName,
    transport: {
      transport: 'stdio',
      command: 'npx',
      args,
      env: { ...(request.env ?? {}) },
      cwd: '',
    },
  })
}

export async function installMcpFromGitNow(
  host: McpConnectorsHost,
  request: InstallMcpFromGitRequest,
  signal: AbortSignal,
): Promise<InstallMcpFromGitResult> {
  const serverName = assertServerName(request.serverName)
  const doc = host.store.load()
  const clash = findByServerName(doc.connectors, serverName)
  if (clash !== undefined) {
    if (request.force !== true) {
      throw new AuxiliaryError(
        'FILE_EDIT_FAILED',
        `serverName "${serverName}" already exists (pass force to replace)`,
      )
    }
    await uninstallMcpConnectorNow(host, { id: clash.id })
  }

  const id = newConnectorId()
  const installed = await installMcpServerFromGit({
    rootDir: host.store.rootDir,
    id,
    source: request.source,
    signal,
    force: true,
    command: request.command,
    args: request.args,
  })

  const transport = {
    ...installed.transport,
    env: { ...installed.transport.env, ...(request.env ?? {}) },
  }

  const now = Date.now()
  const connector: McpConnectorEntry = {
    id,
    serverName,
    enabled: request.enabled !== false,
    channel: 'github',
    sourceLabel: installed.label,
    transport,
    createdAt: now,
    updatedAt: now,
  }
  const latest = host.store.load()
  const snapshot = await persistAndSync(host, [...latest.connectors, connector])
  return { connector, snapshot }
}

export async function importMcpJsonNow(
  host: McpConnectorsHost,
  request: ImportMcpJsonRequest,
): Promise<ImportMcpJsonResult> {
  const parsed = parseMcpJsonText(request.jsonText)
  const imported: McpConnectorEntry[] = []
  const skipped: string[] = []
  for (const server of parsed) {
    const doc = host.store.load()
    const clash = findByServerName(doc.connectors, server.serverName)
    if (clash !== undefined && request.force !== true) {
      skipped.push(server.serverName)
      continue
    }
    if (clash !== undefined && request.force === true) {
      await uninstallMcpConnectorNow(host, { id: clash.id })
    }
    const result = await upsertMcpConnectorNow(host, {
      serverName: server.serverName,
      enabled: request.enabled !== false,
      channel: 'mcpJson',
      sourceLabel: server.sourceLabel,
      transport: server.transport,
    })
    imported.push(result.connector)
  }
  return {
    imported,
    skipped,
    snapshot: snapshotOf(host),
  }
}

export function listMcpConnectorToolsNow(
  host: McpConnectorsHost,
  request: ListMcpConnectorToolsRequest,
): ListMcpConnectorToolsResult {
  const serverName = assertServerName(request.serverName)
  const prefix = `mcp__${serverName}__`
  let definitions: readonly { readonly name: string, readonly description?: string }[] = []
  try {
    definitions = host.ctx.tools.definitions() as readonly {
      readonly name: string
      readonly description?: string
    }[]
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new AuxiliaryError('FILE_EDIT_FAILED', `Cannot list tools: ${detail}`)
  }
  const tools = definitions
    .filter(def => def.name.startsWith(prefix))
    .map(def => ({
      name: def.name,
      description: typeof def.description === 'string' ? def.description : '',
    }))
  return { serverName, tools }
}
