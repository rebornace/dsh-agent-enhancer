import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import {
  resolveBrowserAgentBrowser,
  resolveRunAlertsLevel,
  resolveSettings,
} from '../config.ts'
import type { EnhancerSettings } from '../config.ts'
import { installBrowserAgent } from './browser-agent/install.ts'
import type { BrowserAgentRuntime } from './browser-agent/install.ts'
import { defaultBrowserAgentProfileDir } from './browser-agent/launch.ts'
import { AuxiliaryError } from '../errors.ts'
import {
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PLUGIN_ID,
} from '../identity.ts'
import { buildAuxiliaryModelCatalog } from './catalog.ts'
import { DshCheckpointSessions } from './checkpoint/dsh.ts'
import { DshCheckpointCaptureSwitch } from './checkpoint/live.ts'
import { CheckpointRollbackError, CheckpointRollbackService } from './checkpoint/service.ts'
import type {
  CheckpointCutRequest,
  CheckpointRollbackRequest,
  CheckpointSummariesRequest,
} from './checkpoint/service.ts'
import { SessionCutStore } from './checkpoint/cut-store.ts'
import { installSessionCutFilter } from './checkpoint/cut-live.ts'
import type { SessionCut } from './checkpoint/cut-store.ts'
import { CheckpointStore } from './checkpoint/store.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { compactContextNow } from './context-compact.ts'
import type {
  CompactCommandRuntime,
  CompactEngineRuntime,
  ContextCompactRequest,
  ContextCompactResult,
} from './context-compact.ts'
import { SessionCleanupRegistry } from './session-delete/cleanup.ts'
import {
  createCheckpointCleaner,
  createContextExcludeCleaner,
} from './session-delete/plugin-purge.ts'
import { deleteSessionNow, SessionDeleteError } from './session-delete/delete.ts'
import type { DeleteSessionRequest, DeleteSessionResult } from './session-delete/delete.ts'
import {
  createWebChatWorkspaceNow,
  importWebChatHistoryWithContext,
  listWebChatWorkspacesNow,
  WebChatImportError,
  webChatImportToRemoteError,
  type CreateWebChatWorkspaceResult,
} from './web-chat-bridge/import-session.ts'
import { analyzeWebChatExport } from './web-chat-bridge/parse-export.ts'
import {
  extractWebChatShareId,
  fetchWebChatShareContent,
  parseWebChatShareContent,
  webChatSharePageUrl,
} from './web-chat-bridge/share-link.ts'
import type { AnalyzeWebChatExportResult, WebChatTranscript } from './web-chat-bridge/types.ts'
import type {
  ImportWebChatHistoryRequest,
  ImportWebChatHistoryNowResult,
  WebChatWorkspaceRow,
} from './web-chat-bridge/import-session.ts'
import {
  clearWebChatLoginSnapshot as clearWebChatLoginSnapshotFile,
  loadWebChatLoginSnapshot as loadWebChatLoginSnapshotFile,
  saveWebChatLoginSnapshot as saveWebChatLoginSnapshotFile,
} from './web-chat-bridge/login-snapshot.ts'
import type { WebChatLoginSnapshot } from './web-chat-bridge/login-snapshot.ts'
import {
  addExtraFolderNow,
  listExtraFolderEntriesNow,
  listExtraFoldersNow,
  loadExtraRootPaths,
  pickExtraFolderNow,
  removeExtraFolderNow,
} from './extra-folders/io.ts'
import { createExtraFoldersStore } from './extra-folders/store.ts'
import type { ExtraFoldersStore } from './extra-folders/store.ts'
import { ExtraFoldersError } from './extra-folders/types.ts'
import type {
  AddExtraFolderRequest,
  ListExtraFolderEntriesRequest,
  ListExtraFolderEntriesResult,
  ListExtraFoldersRequest,
  ListExtraFoldersResult,
  PickExtraFolderRequest,
  PickExtraFolderResult,
  RemoveExtraFolderRequest,
} from './extra-folders/types.ts'
import { readWorkspaceFileNow, writeWorkspaceFileNow } from './file-edit/io.ts'
import { installMonacoRoute } from './file-edit/monaco.ts'
import { FileEditError } from './file-edit/types.ts'
import type {
  ReadWorkspaceFileRequest,
  ReadWorkspaceFileResult,
  WriteWorkspaceFileRequest,
  WriteWorkspaceFileResult,
} from './file-edit/types.ts'
import {
  createWorkspaceAgentsNow,
  createWorkspaceSkillNow,
  installSkillFromGitNow,
  installSkillFromZipNow,
  listInstructionsSkillsNow,
  readSkillDocumentNow,
  uninstallSkillNow,
  updateSkillFromGitNow,
} from './instructions-skills/io.ts'
import {
  importMcpJsonNow,
  installMcpFromGitNow,
  installMcpFromNpxNow,
  listMcpConnectorToolsNow,
  listMcpConnectorsNow,
  setMcpConnectorEnabledNow,
  uninstallMcpConnectorNow,
  upsertMcpConnectorNow,
} from './mcp-connectors/io.ts'
import type { McpConnectorsHost } from './mcp-connectors/io.ts'
import { createMcpConnectorsStore } from './mcp-connectors/store.ts'
import { McpConnectorRuntime } from './mcp-connectors/runtime.ts'
import { mcpConnectorsRoot } from './mcp-connectors/paths.ts'
import type {
  ImportMcpJsonRequest,
  ImportMcpJsonResult,
  InstallMcpFromGitRequest,
  InstallMcpFromGitResult,
  InstallMcpFromNpxRequest,
  InstallMcpFromNpxResult,
  ListMcpConnectorToolsRequest,
  ListMcpConnectorToolsResult,
  McpConnectorsSnapshot,
  SetMcpConnectorEnabledRequest,
  SetMcpConnectorEnabledResult,
  UninstallMcpConnectorRequest,
  UninstallMcpConnectorResult,
  UpsertMcpConnectorRequest,
  UpsertMcpConnectorResult,
} from './mcp-connectors/types.ts'
import type {
  CreateWorkspaceAgentsRequest,
  CreateWorkspaceAgentsResult,
  CreateWorkspaceSkillRequest,
  CreateWorkspaceSkillResult,
  GetSkillInstallProgressRequest,
  GetSkillInstallProgressResult,
  InstallSkillFromGitRequest,
  InstallSkillFromGitResult,
  InstallSkillFromZipRequest,
  InstallSkillFromZipResult,
  InstructionsSkillsSnapshot,
  ListInstructionsSkillsRequest,
  ReadSkillDocumentRequest,
  ReadSkillDocumentResult,
  UninstallSkillRequest,
  UninstallSkillResult,
  UpdateSkillFromGitRequest,
  UpdateSkillFromGitResult,
} from './instructions-skills/types.ts'
import { getSkillInstallProgressSnapshot } from './instructions-skills/install-progress.ts'
import { inspectContextCategory, pressureFromProjection } from './context-inspect.ts'
import type { ContextInspectRequest, ContextInspectResult } from './context-inspect.ts'
import { installAutoSessionRoute } from './auto-route/session-hook.ts'
import { SoftPauseGate } from './soft-pause/gate.ts'
import { installSoftPause } from './soft-pause/live.ts'
import { AuxiliaryModels } from './model.ts'
import {
  DEFAULT_BALANCE_REFRESH_MS,
  loadProviderBalances,
  ProviderBalancesCache,
} from './usage/balance.ts'
import type {
  AccountClientMetadata,
  CredentialsResolver,
  DeepSeekAccountBalance,
} from './usage/balance.ts'
import { mergeUsageCalls, sessionUsageFromSessions } from './usage/history.ts'
import { UsageLedger } from './usage/ledger.ts'
import { installUsageObserver } from './usage/observe.ts'
import { withUsageSource } from './usage/source.ts'
import { summarizeUsage } from './usage/summarize.ts'
import type {
  ProviderBalances,
  ProviderBalancesRequest,
  UsageCall,
  UsageRange,
  UsageSummary,
  UsageSummaryReader,
} from './usage/types.ts'
import { checkpointRemoteInfo, remoteInfo } from './rpc.ts'
import type {
  RpcPayload,
  ShowOsNotificationRequest,
  ShowOsNotificationResult,
  BrowserAgentSnapshot,
  BrowserAgentResolveRequest,
  BrowserAgentResolveResult,
  BrowserAgentResolveTabConflictRequest,
  BrowserAgentResolveTabConflictResult,
  BrowserAgentAcknowledgeHumanRequest,
  BrowserAgentAcknowledgeHumanResult,
  BrowserAgentOpenUrlRequest,
  BrowserAgentOpenUrlResult,
  BrowserAgentQuotePageRequest,
  BrowserAgentQuotePageResult,
  BrowserAgentLaunchBrowserRequest,
  BrowserAgentSetBrowserRequest,
  BrowserAgentSetBrowserResult,
  BrowserAgentLaunchBrowserResult,
  SoftPauseSetRequest,
  SoftPauseSnapshotRequest,
  SoftPauseState,
} from './rpc.ts'
import { showOsNotificationNow } from './run-alerts/notify.ts'
import type { AuxiliaryResult } from './types.ts'
import {
  applyPluginUpdateForHost,
  checkPluginUpdateForHost,
} from './update/check.ts'
import type { ApplyUpdateResult, UpdateCheckResult } from './update/types.ts'

export const name = PLUGIN_ID
export const inject = [
  'llm', 'sessions', 'agents', 'sessionProjections', 'agentDefaultModel',
  'fs', 'tools', 'tokenMeter', 'typert', 'typertGateway',
  // Chat `/compact` → compaction.compactNow; commands kept as fallback.
  'commands',
  // Session delete: registry detach + durable workspace/global domain writes.
  'workspaceRegistry', 'storageDomain',
]

export const Config = z.object({
  historyEnabled: z.boolean().default(true).volatile(),
  optimizeEnabled: z.boolean().default(true).volatile(),
  predictEnabled: z.boolean().default(true).volatile(),
  quoteEnabled: z.boolean().default(true).volatile(),
  rollbackEnabled: z.boolean().default(true).volatile(),
  contextInspectEnabled: z.boolean().default(true).volatile(),
  usageEnabled: z.boolean().default(true).volatile(),
  sessionDeleteEnabled: z.boolean().default(true).volatile(),
  fileEditEnabled: z.boolean().default(true).volatile(),
  softPauseEnabled: z.boolean().default(true).volatile(),
  runAlertsEnabled: z.boolean().default(true).volatile(),
  /** Coerced via resolveRunAlertsLevel in readSettings (`hidden` | `unfocused` | `always`). */
  runAlertsLevel: z.string().default('unfocused').volatile(),
  /** High-risk; default off. */
  browserAgentEnabled: z.boolean().default(false).volatile(),
  browserAgentBrowser: z.string().default('auto').volatile(),
  /** Default off; embeds official web chat + import to work. */
  webChatBridgeEnabled: z.boolean().default(true).volatile(),
  instructionsSkillsEnabled: z.boolean().default(true).volatile(),
  mcpConnectorsEnabled: z.boolean().default(true).volatile(),
  // Empty provider/model = follow the current Desktop session model.
  optimizeProvider: z.string().default('').volatile(),
  optimizeModel: z.string().default('').volatile(),
  optimizeReasoningEffort: z.string().default('').volatile(),
  predictProvider: z.string().default('').volatile(),
  predictModel: z.string().default('').volatile(),
  predictReasoningEffort: z.string().default('').volatile(),
  compactProvider: z.string().default('').volatile(),
  compactModel: z.string().default('').volatile(),
  compactReasoningEffort: z.string().default('').volatile(),

  autoClassifierEnabled: z.boolean().default(false).volatile(),
  autoInstantProvider: z.string().default('').volatile(),
  autoInstantModel: z.string().default('').volatile(),
  autoInstantReasoningEffort: z.string().default('').volatile(),
  autoThinkingProvider: z.string().default('').volatile(),
  autoThinkingModel: z.string().default('').volatile(),
  autoThinkingReasoningEffort: z.string().default('').volatile(),
  autoProProvider: z.string().default('').volatile(),
  autoProModel: z.string().default('').volatile(),
  autoProReasoningEffort: z.string().default('').volatile(),
  autoClassifierProvider: z.string().default('').volatile(),
  autoClassifierModel: z.string().default('').volatile(),
  autoClassifierReasoningEffort: z.string().default('').volatile(),
})
export type Config = ReturnType<typeof Config>

/** Single Host package-face contribution. Typert rejects a second register for the same package#face. */
export const hostContribution = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [...remoteInfo.descriptors, ...checkpointRemoteInfo.descriptors],
} as const

export class AgentEnhancerService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly models: AuxiliaryModels,
    private readonly usage: UsageSummaryReader = {
      async summarize(range: UsageRange): Promise<UsageSummary> {
        return summarizeUsage([], range, Date.now())
      },
    },
    private readonly balances: {
      get(force?: boolean, locale?: string): Promise<ProviderBalances>
    } = {
      async get() {
        return {
          account: { source: 'account', status: 'signed-out' },
          apiKey: { source: 'api-key', status: 'no-key' },
        }
      },
    },
    private readonly sessionCleanup: SessionCleanupRegistry = new SessionCleanupRegistry(),
    private readonly extraFolders: ExtraFoldersStore = createExtraFoldersStore(
      join(homedir(), '.dsh', 'profiles', 'desktop', 'plugin-data', PACKAGE_NAME, 'extra-folders'),
    ),
    private readonly softPause: SoftPauseGate = new SoftPauseGate(),
    private readonly softPauseEnabled: () => boolean = () => true,
    private readonly installLedgerRoot: string | undefined = undefined,
    private readonly mcpHost: McpConnectorsHost | null = null,
    private readonly browserAgent: BrowserAgentRuntime | null = null,
    private readonly browserAgentSettings: () => {
      readonly enabled: boolean
      readonly browser: 'auto' | 'chrome' | 'edge'
    } = () => ({
      enabled: false,
      browser: 'auto',
    }),
    /** Apply an explicit launch preference (client form) before ensureReady. */
    private readonly setBrowserAgentBrowser: (browser: 'auto' | 'chrome' | 'edge') => void = () => undefined,
    private readonly browserAgentProfileDir: string = defaultBrowserAgentProfileDir(
      join(homedir(), '.dsh', 'profiles', 'desktop', 'plugin-data', PACKAGE_NAME),
    ),
  ) {
    super(ctx, 'agentEnhancer')
  }

  private browserSnapshotNow(): BrowserAgentSnapshot {
    const settings = this.browserAgentSettings()
    const driverStatus = this.browserAgent?.driverStatus()
    const pending = this.browserAgent?.approval.current() ?? null
    const conflict = this.browserAgent?.sessions.currentConflict() ?? null
    const waiting = this.browserAgent?.human.current() ?? null
    const needsHuman = waiting !== null
      ? {
        sessionId: waiting.sessionId,
        detail: waiting.prompt.trim() !== '' ? waiting.prompt : waiting.detail,
      }
      : (this.browserAgent?.sessions.anyNeedsHuman() ?? null)
    const boundTabId = pending !== null
      ? (this.browserAgent?.sessions.tabOf(pending.sessionId) ?? null)
      : (conflict !== null
        ? conflict.boundTabId
        : (needsHuman !== null
          ? (this.browserAgent?.sessions.tabOf(needsHuman.sessionId) ?? null)
          : null))
    const connected = driverStatus?.ready === true
    const endpoint = driverStatus?.endpoint ?? 'playwright:unlaunched'
    // Exact channel tokens only — do not match `playwright:unlaunched:chrome`.
    const launched = endpoint === 'playwright:msedge'
      ? 'edge' as const
      : endpoint === 'playwright:chrome'
        ? 'chrome' as const
        : null
    return {
      enabled: settings.enabled,
      browser: settings.browser,
      launchedBrowser: launched,
      driver: 'playwright',
      allowedOrigins: [...(this.browserAgent?.approval.allowedOriginList() ?? [])],
      // Wire field kept as `bridge` for client compatibility; values come from Playwright.
      bridge: {
        listening: driverStatus?.listening === true,
        port: 0,
        extensionConnected: connected,
        lastError: driverStatus?.lastError
          ?? (this.browserAgent === null ? 'runtime unavailable' : null),
      },
      pending: pending === null ? null : {
        id: pending.id,
        sessionId: pending.sessionId,
        tool: pending.tool,
        summary: pending.summary,
        ...(pending.url === undefined ? {} : { url: pending.url }),
        ...(pending.origin === undefined ? {} : { origin: pending.origin }),
      },
      tabConflict: conflict,
      needsHuman,
      boundTabId,
      audit: [...(this.browserAgent?.sessions.recentAudit(12) ?? [])],
      profileDir: this.browserAgent?.activeProfileDir() ?? this.browserAgentProfileDir,
    }
  }

  private requireMcpHost(): McpConnectorsHost {
    if (this.mcpHost === null) {
      throw new RemoteError('agent-enhancer/failed', 'MCP connectors host is unavailable', {
        code: 'FILE_EDIT_FAILED',
      })
    }
    return this.mcpHost
  }

  private extraRootsForSession(sessionId: SessionId): readonly string[] {
    const agent = this.ctx.agents.get(sessionId) as
      | { readonly session?: { readonly header?: { readonly cwd?: string } } }
      | undefined
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') return []
    try {
      return loadExtraRootPaths(this.extraFolders, cwd)
    } catch {
      return []
    }
  }

  private assertOwner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('agent-enhancer/forbidden', 'Only the desktop owner may use Agent Enhance', {})
    }
  }

  async call(payload: RpcPayload, signal: AbortSignal): Promise<AuxiliaryResult | null> {
    this.assertOwner()
    try {
      return await this.models.generate(payload.data, signal)
    } catch (error) {
      if (signal.aborted) throw error
      const code = error instanceof AuxiliaryError ? error.code : 'MODEL_FAILED'
      throw new RemoteError('agent-enhancer/failed', 'Agent Enhance request failed', { code })
    }
  }

  /** Same Desktop catalog the official model selector uses (`llm` registry). */
  async listCatalog(): Promise<ModelCatalog> {
    // Listing is read-only; do not require the owner gate used by generate.
    try {
      return await buildAuxiliaryModelCatalog(this.ctx)
    } catch {
      throw new RemoteError('agent-enhancer/failed', 'Agent Enhance catalog failed', {
        code: 'MODEL_UNAVAILABLE',
      })
    }
  }

  async inspectContext(request: ContextInspectRequest, signal: AbortSignal): Promise<ContextInspectResult> {
    this.assertOwner()
    signal.throwIfAborted()
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError('agent-enhancer/failed', 'Session not available for context inspect', {
        code: 'SESSION_CHANGED',
      })
    }
    try {
      const inspected = inspectContextCategory(agent.session, request.category, this.ctx.tokenMeter)
      const pressureView = this.ctx.sessionProjections
        .snapshot(agent.session, ['contextPressure'])
        .values
        .contextPressure
      return {
        sessionId: request.sessionId,
        ...inspected,
        pressure: pressureFromProjection(pressureView),
      }
    } catch (error) {
      if (signal.aborted) throw error
      throw new RemoteError('agent-enhancer/failed', 'Context inspect failed', { code: 'MODEL_FAILED' })
    }
  }

  /** Permanently delete one sidebar session (official logs + plugin persistence). */
  async deleteSession(request: DeleteSessionRequest, signal: AbortSignal): Promise<DeleteSessionResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await deleteSessionNow({
        ctx: this.ctx,
        request,
        cleanup: this.sessionCleanup,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      if (error instanceof SessionDeleteError) {
        this.ctx.logger.warn(`agent-enhancer deleteSession failed: ${error.code} ${error.message}`)
        throw new RemoteError('agent-enhancer/failed', error.message, {
          code: error.code === 'BUSY' ? 'SESSION_BUSY' : 'SESSION_DELETE_FAILED',
        })
      }
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-enhancer deleteSession failed: ${detail}`)
      throw new RemoteError('agent-enhancer/failed', detail || 'Session delete failed', {
        code: 'SESSION_DELETE_FAILED',
      })
    }
  }

  /** Workspaces eligible for imported web-chat sessions. */
  async listWebChatWorkspaces(
    _request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ items: readonly WebChatWorkspaceRow[] }> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return { items: listWebChatWorkspacesNow(this.ctx) }
    } catch (error) {
      if (signal.aborted) throw error
      throw webChatImportToRemoteError(error)
    }
  }

  /** Pick a folder and register it as a workspace for web-chat import. */
  async createWebChatWorkspace(
    _request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<CreateWebChatWorkspaceResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await createWebChatWorkspaceNow(this.ctx, signal)
    } catch (error) {
      if (signal.aborted) throw error
      throw webChatImportToRemoteError(error)
    }
  }

  /** Create a Desktop session from a captured/exported web transcript (no model call). */
  async importWebChatHistory(
    request: ImportWebChatHistoryRequest,
    signal: AbortSignal,
  ): Promise<ImportWebChatHistoryNowResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await importWebChatHistoryWithContext(this.ctx, request)
    } catch (error) {
      if (signal.aborted) throw error
      throw webChatImportToRemoteError(error)
    }
  }

  /** Analyze an official export into selectable conversations (size limits enforced once). */
  async parseWebChatExport(
    request: { readonly filename: string, readonly bytesBase64: string },
    signal: AbortSignal,
  ): Promise<AnalyzeWebChatExportResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      const bytes = Buffer.from(request.bytesBase64, 'base64')
      return analyzeWebChatExport({ filename: request.filename, bytes })
    } catch (error) {
      if (signal.aborted) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw webChatImportToRemoteError(
        error instanceof WebChatImportError
          ? error
          : new WebChatImportError('invalid-transcript', detail),
      )
    }
  }

  /**
   * Resolve a public DeepSeek share link (`chat.deepseek.com/share/…`) into a transcript.
   * Prefer `payloadJson` from the guest (same-origin) when WAF blocks Host fetch.
   */
  async resolveWebChatShareLink(
    request: { readonly shareUrl: string, readonly payloadJson?: string },
    signal: AbortSignal,
  ): Promise<{ transcript: WebChatTranscript }> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      const shareId = extractWebChatShareId(request.shareUrl)
      if (shareId === null) {
        throw new WebChatImportError('invalid-transcript', 'unrecognized-share: not a DeepSeek share link')
      }
      const shareUrl = webChatSharePageUrl(shareId)
      let data: unknown
      if (typeof request.payloadJson === 'string' && request.payloadJson.trim() !== '') {
        try {
          data = JSON.parse(request.payloadJson) as unknown
        } catch {
          throw new WebChatImportError('invalid-transcript', 'unrecognized-share: invalid payload json')
        }
      } else {
        data = await fetchWebChatShareContent(shareId, signal)
      }
      const transcript = parseWebChatShareContent(data, { shareUrl, shareId })
      return { transcript }
    } catch (error) {
      if (signal.aborted) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw webChatImportToRemoteError(
        error instanceof WebChatImportError
          ? error
          : new WebChatImportError('invalid-transcript', detail),
      )
    }
  }

  private webChatPluginDataRoot(): string {
    return this.installLedgerRoot
      ?? join(homedir(), '.dsh', 'profiles', 'desktop', 'plugin-data', PACKAGE_NAME)
  }

  /** User-level web chat guest login snapshot (non-HttpOnly storage only). */
  async loadWebChatLoginSnapshot(
    _request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ snapshot: WebChatLoginSnapshot | null }> {
    this.assertOwner()
    signal.throwIfAborted()
    return { snapshot: loadWebChatLoginSnapshotFile(this.webChatPluginDataRoot()) }
  }

  async saveWebChatLoginSnapshot(
    request: {
      readonly localStorage: Readonly<Record<string, string>>
      readonly cookie: string
      readonly savedAt: string
    },
    signal: AbortSignal,
  ): Promise<{ ok: true }> {
    this.assertOwner()
    signal.throwIfAborted()
    saveWebChatLoginSnapshotFile(this.webChatPluginDataRoot(), request)
    return { ok: true }
  }

  async clearWebChatLoginSnapshot(
    _request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<{ cleared: boolean }> {
    this.assertOwner()
    signal.throwIfAborted()
    return { cleared: clearWebChatLoginSnapshotFile(this.webChatPluginDataRoot()) }
  }

  /** Read a workspace UTF-8 text file for the in-app Monaco editor. */
  async readWorkspaceFile(
    request: ReadWorkspaceFileRequest,
    signal: AbortSignal,
  ): Promise<ReadWorkspaceFileResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await readWorkspaceFileNow({
        ctx: this.ctx,
        request,
        signal,
        extraRoots: this.extraRootsForSession(request.sessionId),
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw fileEditRemoteError(error)
    }
  }

  /** Write a workspace UTF-8 text file from the in-app Monaco editor. */
  async writeWorkspaceFile(
    request: WriteWorkspaceFileRequest,
    signal: AbortSignal,
  ): Promise<WriteWorkspaceFileResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await writeWorkspaceFileNow({
        ctx: this.ctx,
        request,
        signal,
        extraRoots: this.extraRootsForSession(request.sessionId),
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw fileEditRemoteError(error)
    }
  }

  async listExtraFolders(
    request: ListExtraFoldersRequest,
    signal: AbortSignal,
  ): Promise<ListExtraFoldersResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await listExtraFoldersNow({
        ctx: this.ctx,
        store: this.extraFolders,
        request,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw extraFoldersRemoteError(error)
    }
  }

  async addExtraFolder(
    request: AddExtraFolderRequest,
    signal: AbortSignal,
  ): Promise<ListExtraFoldersResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await addExtraFolderNow({
        ctx: this.ctx,
        store: this.extraFolders,
        request,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw extraFoldersRemoteError(error)
    }
  }

  async pickExtraFolder(
    request: PickExtraFolderRequest,
    signal: AbortSignal,
  ): Promise<PickExtraFolderResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await pickExtraFolderNow({
        ctx: this.ctx,
        store: this.extraFolders,
        request,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw extraFoldersRemoteError(error)
    }
  }

  async removeExtraFolder(
    request: RemoveExtraFolderRequest,
    signal: AbortSignal,
  ): Promise<ListExtraFoldersResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await removeExtraFolderNow({
        ctx: this.ctx,
        store: this.extraFolders,
        request,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw extraFoldersRemoteError(error)
    }
  }

  async listExtraFolderEntries(
    request: ListExtraFolderEntriesRequest,
    signal: AbortSignal,
  ): Promise<ListExtraFolderEntriesResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await listExtraFolderEntriesNow({
        ctx: this.ctx,
        store: this.extraFolders,
        request,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw extraFoldersRemoteError(error)
    }
  }

  /** Trigger official idle compaction (same seam as chat `/compact`). */
  async compactContext(request: ContextCompactRequest, signal: AbortSignal): Promise<ContextCompactResult> {
    this.assertOwner()
    signal.throwIfAborted()
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent === undefined) {
      throw new RemoteError('agent-enhancer/failed', 'Session not available for compaction', {
        code: 'SESSION_CHANGED',
      })
    }
    try {
      // Prefer ctx.compaction.compactNow — identical to the official /compact handler.
      return await withUsageSource('compact', async () => compactContextNow({
        compaction: softService<CompactEngineRuntime>(this.ctx, 'compaction', 'compactNow'),
        commands: softService<CompactCommandRuntime>(this.ctx, 'commands', 'execute')
          ?? this.ctx.commands,
        agent,
        sessionId: request.sessionId,
        signal,
      }))
    } catch (error) {
      if (signal.aborted) throw error
      const code = error instanceof AuxiliaryError ? error.code : 'COMPACT_FAILED'
      const detail = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`agent-enhancer compact failed (${code}): ${detail}`)
      throw new RemoteError('agent-enhancer/failed', detail || 'Context compaction failed', { code })
    }
  }

  /** Read-only version probe — same gate policy as `listCatalog` (settings-safe). */
  async checkUpdate(): Promise<UpdateCheckResult> {
    return checkPluginUpdateForHost()
  }

  async usageSummary(range: UsageRange): Promise<UsageSummary> {
    this.assertOwner()
    return this.usage.summarize(range)
  }

  /** Per Models-card balances — account login and API key are independent. */
  async providerBalances(request: ProviderBalancesRequest = {}): Promise<ProviderBalances> {
    this.assertOwner()
    return this.balances.get(request.force === true, request.locale)
  }

  /** List AGENTS.md / CLAUDE.md chain + skills for the session workspace. */
  async listInstructionsSkills(
    request: ListInstructionsSkillsRequest,
    signal: AbortSignal,
  ): Promise<InstructionsSkillsSnapshot> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await listInstructionsSkillsNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Create workspace-root AGENTS.md when missing. */
  async createWorkspaceAgents(
    request: CreateWorkspaceAgentsRequest,
    signal: AbortSignal,
  ): Promise<CreateWorkspaceAgentsResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await createWorkspaceAgentsNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Create `.agents/skills/<name>/SKILL.md` under the project root. */
  async createWorkspaceSkill(
    request: CreateWorkspaceSkillRequest,
    signal: AbortSignal,
  ): Promise<CreateWorkspaceSkillResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await createWorkspaceSkillNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Shallow-clone a git/GitHub source and copy skill bundles into user or project skills. */
  async installSkillFromGit(
    request: InstallSkillFromGitRequest,
    signal: AbortSignal,
  ): Promise<InstallSkillFromGitResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await installSkillFromGitNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Poll GitHub skill install/update stage while installSkillFromGit / updateSkillFromGit runs. */
  async getSkillInstallProgress(
    request: GetSkillInstallProgressRequest,
    signal: AbortSignal,
  ): Promise<GetSkillInstallProgressResult> {
    this.assertOwner()
    signal.throwIfAborted()
    return getSkillInstallProgressSnapshot(String(request.sessionId))
  }

  /** Remove a skill from a managed install root (user/project skills). */
  async uninstallSkill(
    request: UninstallSkillRequest,
    signal: AbortSignal,
  ): Promise<UninstallSkillResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await uninstallSkillNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Install skills from a local .zip (opens a file picker when zipPath is omitted). */
  async installSkillFromZip(
    request: InstallSkillFromZipRequest,
    signal: AbortSignal,
  ): Promise<InstallSkillFromZipResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await installSkillFromZipNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Re-install one GitHub-tracked skill from its ledger source with force overwrite. */
  async updateSkillFromGit(
    request: UpdateSkillFromGitRequest,
    signal: AbortSignal,
  ): Promise<UpdateSkillFromGitResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await updateSkillFromGitNow({
        ctx: this.ctx,
        request,
        signal,
        installLedgerRoot: this.installLedgerRoot,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /**
   * Read SKILL.md for in-panel preview.
   * Desktop hides the rightbar while a left `main` panel is selected, so Skills
   * cannot use `sidebarRight.openResource` without leaving the page.
   */
  async readSkillDocument(
    request: ReadSkillDocumentRequest,
    signal: AbortSignal,
  ): Promise<ReadSkillDocumentResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await readSkillDocumentNow({
        ctx: this.ctx,
        request,
        signal,
      })
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async listMcpConnectors(
    _request: Record<string, never>,
    signal: AbortSignal,
  ): Promise<McpConnectorsSnapshot> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await listMcpConnectorsNow(this.requireMcpHost())
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async upsertMcpConnector(
    request: UpsertMcpConnectorRequest,
    signal: AbortSignal,
  ): Promise<UpsertMcpConnectorResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await upsertMcpConnectorNow(this.requireMcpHost(), request)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async setMcpConnectorEnabled(
    request: SetMcpConnectorEnabledRequest,
    signal: AbortSignal,
  ): Promise<SetMcpConnectorEnabledResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await setMcpConnectorEnabledNow(this.requireMcpHost(), request)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async uninstallMcpConnector(
    request: UninstallMcpConnectorRequest,
    signal: AbortSignal,
  ): Promise<UninstallMcpConnectorResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await uninstallMcpConnectorNow(this.requireMcpHost(), request)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async installMcpFromNpx(
    request: InstallMcpFromNpxRequest,
    signal: AbortSignal,
  ): Promise<InstallMcpFromNpxResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await installMcpFromNpxNow(this.requireMcpHost(), request)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async installMcpFromGit(
    request: InstallMcpFromGitRequest,
    signal: AbortSignal,
  ): Promise<InstallMcpFromGitResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await installMcpFromGitNow(this.requireMcpHost(), request, signal)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async importMcpJson(
    request: ImportMcpJsonRequest,
    signal: AbortSignal,
  ): Promise<ImportMcpJsonResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return await importMcpJsonNow(this.requireMcpHost(), request)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  async listMcpConnectorTools(
    request: ListMcpConnectorToolsRequest,
    signal: AbortSignal,
  ): Promise<ListMcpConnectorToolsResult> {
    this.assertOwner()
    signal.throwIfAborted()
    try {
      return listMcpConnectorToolsNow(this.requireMcpHost(), request)
    } catch (error) {
      if (signal.aborted) throw error
      throw instructionsSkillsRemoteError(error)
    }
  }

  /** Soft-pause gate snapshot for the latest-user-bubble Pause / Resume control. */
  async softPauseSnapshot(request: SoftPauseSnapshotRequest): Promise<SoftPauseState> {
    this.assertOwner()
    if (!this.softPauseEnabled()) {
      if (this.softPause.isEngaged(request.sessionId)) this.softPause.release(request.sessionId)
      return { sessionId: request.sessionId, engaged: false }
    }
    return { sessionId: request.sessionId, engaged: this.softPause.isEngaged(request.sessionId) }
  }

  /** Engage or release the soft-pause gate (no new user turn on resume). */
  async softPauseSet(request: SoftPauseSetRequest): Promise<SoftPauseState> {
    this.assertOwner()
    if (!this.softPauseEnabled()) {
      this.softPause.release(request.sessionId)
      return { sessionId: request.sessionId, engaged: false }
    }
    if (request.engaged) this.softPause.engage(request.sessionId)
    else this.softPause.release(request.sessionId)
    return { sessionId: request.sessionId, engaged: this.softPause.isEngaged(request.sessionId) }
  }

  /** Desktop OS notification for run alerts (Electron / Windows Action Center). */
  async showOsNotification(request: ShowOsNotificationRequest): Promise<ShowOsNotificationResult> {
    this.assertOwner()
    return await showOsNotificationNow(request)
  }

  async browserAgentSnapshot(): Promise<BrowserAgentSnapshot> {
    this.assertOwner()
    return this.browserSnapshotNow()
  }

  async browserAgentResolve(request: BrowserAgentResolveRequest): Promise<BrowserAgentResolveResult> {
    this.assertOwner()
    const ok = this.browserAgent?.approval.resolve(request.id, request.decision) ?? false
    return { ok, snapshot: this.browserSnapshotNow() }
  }

  async browserAgentResolveTabConflict(
    request: BrowserAgentResolveTabConflictRequest,
  ): Promise<BrowserAgentResolveTabConflictResult> {
    this.assertOwner()
    const result = await this.browserAgent?.resolveTabConflict(request.decision)
    return { ok: result?.ok === true, snapshot: this.browserSnapshotNow() }
  }

  async browserAgentAcknowledgeHuman(
    request: BrowserAgentAcknowledgeHumanRequest,
  ): Promise<BrowserAgentAcknowledgeHumanResult> {
    this.assertOwner()
    const ok = this.browserAgent?.acknowledgeHuman(request.sessionId) === true
    return { ok, snapshot: this.browserSnapshotNow() }
  }

  async browserAgentOpenUrl(request: BrowserAgentOpenUrlRequest): Promise<BrowserAgentOpenUrlResult> {
    this.assertOwner()
    const result = await this.browserAgent?.openUrl({
      sessionId: request.sessionId,
      url: request.url,
    })
    return {
      ok: result?.ok === true,
      ...(result?.url === undefined ? {} : { url: result.url }),
      ...(result?.title === undefined ? {} : { title: result.title }),
      ...(result?.error === undefined ? {} : { error: result.error }),
      snapshot: this.browserSnapshotNow(),
    }
  }

  async browserAgentQuotePage(request: BrowserAgentQuotePageRequest): Promise<BrowserAgentQuotePageResult> {
    this.assertOwner()
    const result = await this.browserAgent?.quotePage(request.sessionId)
    return {
      ok: result?.ok === true,
      ...(result?.text === undefined ? {} : { text: result.text }),
      ...(result?.url === undefined ? {} : { url: result.url }),
      ...(result?.title === undefined ? {} : { title: result.title }),
      ...(result?.error === undefined ? {} : { error: result.error }),
      snapshot: this.browserSnapshotNow(),
    }
  }

  async browserAgentLaunchBrowser(
    request: BrowserAgentLaunchBrowserRequest,
  ): Promise<BrowserAgentLaunchBrowserResult> {
    this.assertOwner()
    const settings = this.browserAgentSettings()
    if (!settings.enabled) {
      return {
        ok: false,
        profileDir: this.browserAgentProfileDir,
        error: 'Browser agent is disabled in settings.',
        snapshot: this.browserSnapshotNow(),
      }
    }
    // Client-selected browser is authoritative for this launch (not cached Cordis config).
    const preference = request.browser ?? settings.browser
    this.setBrowserAgentBrowser(preference)
    const launched = await this.browserAgent?.launchDedicated(undefined, preference)
    const snapshot = this.browserSnapshotNow()
    return {
      ok: launched?.ok === true,
      profileDir: this.browserAgent?.activeProfileDir() ?? this.browserAgentProfileDir,
      ...(snapshot.launchedBrowser === null ? {} : { browser: snapshot.launchedBrowser }),
      ...(launched?.error === undefined ? {} : { error: launched.error }),
      snapshot,
    }
  }

  async browserAgentSetBrowser(
    request: BrowserAgentSetBrowserRequest,
  ): Promise<BrowserAgentSetBrowserResult> {
    this.assertOwner()
    // Immediate live mirror — do not wait for Cordis internal/update (Settings
    // write alone left Agent tools on the previous Chrome/Edge until Launch).
    this.setBrowserAgentBrowser(request.browser)
    const settings = this.browserAgentSettings()
    if (settings.enabled && this.browserAgent?.driverStatus()?.ready === true) {
      // Already headed: hard-switch now so Settings takes effect without the overlay Launch button.
      await this.browserAgent.alignToPreference()
    }
    return {
      ok: true,
      browser: request.browser,
      snapshot: this.browserSnapshotNow(),
    }
  }

  async applyUpdate(): Promise<ApplyUpdateResult> {
    this.assertOwner()
    return applyPluginUpdateForHost({
      linkBlocked: 'link',
      success: 'restart',
      failed: 'failed',
      noUpdate: 'none',
      manualOnly: 'manual',
    })
  }
}

function resolveCheckpointRoot(dshHome: string): string {
  const base = join(dshHome, 'profiles', 'desktop', 'plugin-data')
  const nextPkg = join(base, PACKAGE_NAME)
  const next = join(nextPkg, 'checkpoint')
  const prev = join(base, LEGACY_PACKAGE_NAME, 'checkpoint')
  if (!existsSync(next) && existsSync(prev)) {
    mkdirSync(nextPkg, { recursive: true })
    renameSync(prev, next)
    const prevPkg = join(base, LEGACY_PACKAGE_NAME)
    try {
      if (existsSync(prevPkg) && readdirSync(prevPkg).length === 0) rmdirSync(prevPkg)
    } catch {
      // Best-effort cleanup of the empty legacy package folder.
    }
  }
  return next
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentEnhancer: AgentEnhancerService
    /** Present when `@deepseek-ai/dsh-commands` is loaded in this profile. */
    commands: CompactCommandRuntime
  }
}

function fileEditRemoteError(error: unknown): RemoteError {
  if (error instanceof FileEditError) {
    return new RemoteError('agent-enhancer/failed', error.message, { code: error.code })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new RemoteError('agent-enhancer/failed', detail || 'File edit failed', {
    code: 'FILE_EDIT_FAILED',
  })
}

function extraFoldersRemoteError(error: unknown): RemoteError {
  if (error instanceof ExtraFoldersError) {
    return new RemoteError('agent-enhancer/failed', error.message, { code: error.code })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new RemoteError('agent-enhancer/failed', detail || 'Extra folders failed', {
    code: 'FILE_EDIT_FAILED',
  })
}

function instructionsSkillsRemoteError(error: unknown): RemoteError {
  if (error instanceof AuxiliaryError) {
    return new RemoteError('agent-enhancer/failed', error.message, { code: error.code })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return new RemoteError('agent-enhancer/failed', detail || 'Instructions & skills failed', {
    code: 'FILE_EDIT_FAILED',
  })
}

function softService<T extends object>(
  ctx: Context,
  name: string,
  method: string,
): T | undefined {
  // Soft lookup: `ctx.<name>` / Reflect.get throws without an inject
  // declaration. Official adapters use `ctx.get(...)` for optional seams.
  try {
    const value = ctx.get(name) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    if (typeof Reflect.get(value, method) !== 'function') return undefined
    return value as T
  } catch {
    return undefined
  }
}

function credentialsOf(ctx: Context): CredentialsResolver | undefined {
  return softService<CredentialsResolver>(ctx, 'credentials', 'resolve')
}

function deepSeekAccountOf(ctx: Context): DeepSeekAccountBalance | undefined {
  return softService<DeepSeekAccountBalance>(ctx, 'deepseekAccount', 'getBalance')
}

function accountClientMetadata(locale?: string): AccountClientMetadata {
  return {
    version: PACKAGE_VERSION,
    locale: locale !== undefined && locale.trim() !== '' ? locale.trim() : 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function readSettings(config: Config): EnhancerSettings {
  return resolveSettings({
    historyEnabled: config.historyEnabled.get(),
    optimizeEnabled: config.optimizeEnabled.get(),
    predictEnabled: config.predictEnabled.get(),
    quoteEnabled: config.quoteEnabled.get(),
    rollbackEnabled: config.rollbackEnabled.get(),
    contextInspectEnabled: config.contextInspectEnabled.get(),
    usageEnabled: config.usageEnabled.get(),
    sessionDeleteEnabled: config.sessionDeleteEnabled.get(),
    fileEditEnabled: config.fileEditEnabled.get(),
    softPauseEnabled: config.softPauseEnabled.get(),
    runAlertsEnabled: config.runAlertsEnabled.get(),
    runAlertsLevel: resolveRunAlertsLevel(config.runAlertsLevel.get()),
    browserAgentEnabled: config.browserAgentEnabled.get(),
    browserAgentBrowser: resolveBrowserAgentBrowser(config.browserAgentBrowser.get()),
    webChatBridgeEnabled: config.webChatBridgeEnabled.get(),
    instructionsSkillsEnabled: config.instructionsSkillsEnabled.get(),
    mcpConnectorsEnabled: config.mcpConnectorsEnabled.get(),
    optimizeProvider: config.optimizeProvider.get(),
    optimizeModel: config.optimizeModel.get(),
    optimizeReasoningEffort: config.optimizeReasoningEffort.get(),
    predictProvider: config.predictProvider.get(),
    predictModel: config.predictModel.get(),
    predictReasoningEffort: config.predictReasoningEffort.get(),
    compactProvider: config.compactProvider.get(),
    compactModel: config.compactModel.get(),
    compactReasoningEffort: config.compactReasoningEffort.get(),
    autoClassifierEnabled: config.autoClassifierEnabled.get(),
    autoInstantProvider: config.autoInstantProvider.get(),
    autoInstantModel: config.autoInstantModel.get(),
    autoInstantReasoningEffort: config.autoInstantReasoningEffort.get(),
    autoThinkingProvider: config.autoThinkingProvider.get(),
    autoThinkingModel: config.autoThinkingModel.get(),
    autoThinkingReasoningEffort: config.autoThinkingReasoningEffort.get(),
    autoProProvider: config.autoProProvider.get(),
    autoProModel: config.autoProModel.get(),
    autoProReasoningEffort: config.autoProReasoningEffort.get(),
    autoClassifierProvider: config.autoClassifierProvider.get(),
    autoClassifierModel: config.autoClassifierModel.get(),
    autoClassifierReasoningEffort: config.autoClassifierReasoningEffort.get(),
  })
}

export function apply(ctx: Context, config: Config): void {
  const settings = () => readSettings(config)
  const models = new AuxiliaryModels(ctx, settings)
  installAutoSessionRoute(ctx, { settings })
  const storageRoot = resolveCheckpointRoot(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const pluginDataPackageRoot = join(storageRoot, '..')
  const usage = new UsageLedger(join(storageRoot, '..', 'usage'), message => {
    ctx.logger.warn(message)
  })
  const balancesFacade = (() => {
    let locale = 'zh-CN'
    const cache = new ProviderBalancesCache(
      DEFAULT_BALANCE_REFRESH_MS,
      async () => loadProviderBalances({
        credentials: credentialsOf(ctx),
        account: deepSeekAccountOf(ctx),
        client: accountClientMetadata(locale),
      }),
    )
    return {
      async get(force = false, nextLocale?: string): Promise<ProviderBalances> {
        if (nextLocale !== undefined && nextLocale.trim() !== '') locale = nextLocale.trim()
        try {
          return await cache.get(force)
        } catch (error) {
          ctx.logger.warn(`agent-enhancer: provider balances failed: ${String(error)}`)
          return {
            account: { source: 'account', status: 'unavailable' },
            apiKey: { source: 'api-key', status: 'unavailable' },
          }
        }
      },
    }
  })()
  installUsageObserver(ctx, usage)
  const store = new CheckpointStore(storageRoot)
  const cutStore = new SessionCutStore(join(storageRoot, 'cuts'))
  const cutCache = new Map<SessionId, SessionCut | null>()
  const sessionCleanup = new SessionCleanupRegistry()
  sessionCleanup.register(createCheckpointCleaner({ store, cutStore, storageRoot }))
  sessionCleanup.register(createContextExcludeCleaner(join(storageRoot, '..')))
  const extraFoldersStore = createExtraFoldersStore(join(storageRoot, '..', 'extra-folders'))
  const softPauseGate = new SoftPauseGate()
  const mcpStore = createMcpConnectorsStore(mcpConnectorsRoot(pluginDataPackageRoot))
  const mcpRuntime = new McpConnectorRuntime(ctx, mcpStore)
  mcpRuntime.setFeatureEnabled(settings().mcpConnectorsEnabled)
  const mcpHost: McpConnectorsHost = { ctx, store: mcpStore, runtime: mcpRuntime }
  void mcpRuntime.sync().catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`agent-enhancer: initial MCP connector sync failed: ${detail}`)
  })
  const browserAgentProfileDir = defaultBrowserAgentProfileDir(pluginDataPackageRoot)
  // Cordis volatile updates: apply()'s `config` getters can lag. Keep a live
  // mirror from resolvedConfig (never re-read stale apply config after next()).
  const browserAgentLive = {
    enabled: settings().browserAgentEnabled,
    browser: settings().browserAgentBrowser,
  }
  const browserAgent = installBrowserAgent(ctx, {
    enabled: () => browserAgentLive.enabled,
    browserPreference: () => browserAgentLive.browser,
    profileRoot: pluginDataPackageRoot,
    softPause: softPauseGate,
    softPauseEnabled: () => settings().softPauseEnabled,
    onBrowserMutation: info => {
      try {
        ctx.emit('agent-enhancer/browser-agent/mutation' as never, info as never)
      } catch {
        // Optional event for skills / future checkpoint tips.
      }
    },
  })
  sessionCleanup.register({
    id: 'browser-agent',
    label: 'Browser agent session memory',
    async purge(sessionId) {
      browserAgent.approval.clearSession(sessionId)
      browserAgent.human.clearSession(sessionId)
      browserAgent.sessions.clearSession(sessionId)
      softPauseGate.release(sessionId)
    },
  })
  new AgentEnhancerService(ctx, models, {
      async summarize(range) {
        const stored = await usage.listCalls()
        let history: UsageCall[] = []
        try {
          const store = ctx.get('sessions') as unknown as SessionStore
          history = sessionUsageFromSessions(store.list())
        } catch {
          history = []
        }
        // Models cards own live balance; bill keeps estimate only.
        return summarizeUsage(mergeUsageCalls(stored, history), range, Date.now())
      },
    },
    balancesFacade,
    sessionCleanup,
    extraFoldersStore,
    softPauseGate,
    () => settings().softPauseEnabled,
    pluginDataPackageRoot,
    mcpHost,
    browserAgent,
    () => ({
      enabled: browserAgentLive.enabled,
      browser: browserAgentLive.browser,
    }),
    browser => {
      // Preference only — do not refresh/remount here. launchDedicated hard-resets.
      browserAgentLive.browser = resolveBrowserAgentBrowser(browser)
    },
    browserAgentProfileDir,
  )
  ctx.effect(() => {
    const unsubscribe = ctx.on('internal/update', (resolvedConfig, next) => {
      const cfg = resolvedConfig as Config
      const enabled = cfg.mcpConnectorsEnabled.get()
      mcpRuntime.setFeatureEnabled(enabled)
      void mcpRuntime.sync().catch(error => {
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`agent-enhancer: MCP connector sync after settings update failed: ${detail}`)
      })
      const prevEnabled = browserAgentLive.enabled
      const prevBrowser = browserAgentLive.browser
      browserAgentLive.enabled = cfg.browserAgentEnabled.get()
      browserAgentLive.browser = resolveBrowserAgentBrowser(cfg.browserAgentBrowser.get())
      // Remount only when the feature is toggled on/off — not on every Chrome↔Edge
      // change (that raced with Launch and left the first browser stuck).
      if (prevEnabled !== browserAgentLive.enabled) {
        browserAgent.refresh()
      } else if (
        browserAgentLive.enabled
        && prevBrowser !== browserAgentLive.browser
        && browserAgent.driverStatus()?.ready === true
      ) {
        // Cordis Settings Chrome↔Edge while headed: hard-align without requiring Launch.
        void browserAgent.alignToPreference().catch(error => {
          const detail = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`agent-enhancer: browser preference align after settings failed: ${detail}`)
        })
      }
      return next()
    })
    return async () => {
      unsubscribe()
      await mcpRuntime.disposeAll()
      await browserAgent.dispose()
    }
  })
  installSoftPause(ctx, {
    gate: softPauseGate,
    enabled: () => settings().softPauseEnabled,
  })
  ctx.effect(() => ctx.typert.register(hostContribution))
  // Monaco is optional — never let route install throw and tear down this fiber
  // (that makes settings mutate report "Plugin entry is no longer configurable").
  try {
    installMonacoRoute(ctx)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`agent-enhancer: Monaco route install failed: ${detail}`)
  }

  const sessions = new DshCheckpointSessions(ctx)
  let rollbackEnabled = config.rollbackEnabled.get()
  const captures = new DshCheckpointCaptureSwitch(ctx, { store, pluginVersion: PACKAGE_VERSION })
  const rollback = new CheckpointRollbackService({
    store,
    storageRoot,
    pluginVersion: PACKAGE_VERSION,
    resolveSession: sessions.resolveSession,
    isEnabled: () => rollbackEnabled,
    awaitCaptures: () => captures.awaitPending(),
    cutStore,
    cutCache,
  })
  applyCheckpointRollback(ctx, rollback)
  void rollback.recover().catch(() => {
    ctx.logger.warn('Checkpoint rollback recovery is still pending')
  })
  ctx.effect(() => installSessionCutFilter(ctx, { store: cutStore, cache: cutCache }))

  ctx.effect(() => {
    // Cordis 4.1: internal/update is (resolvedConfig, next); noSave moved to Fiber.update.
    const unsubscribe = ctx.on('internal/update', (resolvedConfig, next) => {
      rollbackEnabled = (resolvedConfig as Config).rollbackEnabled.get()
      captures.setEnabled(rollbackEnabled)
      return next()
    })
    captures.setEnabled(rollbackEnabled)
    return async () => {
      unsubscribe()
      rollbackEnabled = false
      await captures.close()
    }
  })
}

/** @deprecated Checkpoint invocations live on hostContribution; kept for test imports. */
export const checkpointHostContribution = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: checkpointRemoteInfo.descriptors,
} as const

export class CheckpointRollbackRemoteService extends TypertRemoteService {
  constructor(ctx: Context, private readonly rollback: CheckpointRollbackService) {
    super(ctx, 'checkpointRollback')
  }

  async preview(request: CheckpointRollbackRequest, signal: AbortSignal) {
    this.assertOwner()
    try {
      return await this.rollback.preview(request, signal)
    } catch (error) {
      throw this.remoteError(error, signal)
    }
  }

  async execute(request: CheckpointRollbackRequest, signal: AbortSignal) {
    this.assertOwner()
    try {
      return await this.rollback.execute(request, signal)
    } catch (error) {
      throw this.remoteError(error, signal)
    }
  }

  async summaries(request: CheckpointSummariesRequest, signal: AbortSignal) {
    this.assertOwner()
    try {
      return await this.rollback.summaries(request, signal)
    } catch (error) {
      throw this.remoteError(error, signal)
    }
  }

  async getCut(request: CheckpointCutRequest, signal: AbortSignal) {
    this.assertOwner()
    try {
      return await this.rollback.getCut(request, signal)
    } catch (error) {
      throw this.remoteError(error, signal)
    }
  }

  private assertOwner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('agent-enhancer/forbidden', 'Only the desktop owner may use checkpoint rollback', {})
    }
  }

  private remoteError(error: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return error
    const code = error instanceof CheckpointRollbackError ? error.code : 'ROLLBACK_FAILED'
    return new RemoteError('agent-enhancer/rollback-failed', 'Checkpoint rollback request failed', { code })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    checkpointRollback: CheckpointRollbackRemoteService
  }
}

export function applyCheckpointRollback(ctx: Context, rollback: CheckpointRollbackService): void {
  new CheckpointRollbackRemoteService(ctx, rollback)
  ctx.effect(() => async () => { await rollback.close() })
}
