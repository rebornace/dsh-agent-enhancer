import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { AuxiliaryErrorCode } from '../errors.ts'
import type { CheckpointRollbackErrorCode } from './checkpoint/service.ts'
import { SKILL_INSTALL_STAGES } from './instructions-skills/install-progress.ts'
import { APPLY_UPDATE_CODES } from './update/types.ts'
import { USAGE_RANGES, USAGE_SOURCES } from './usage/types.ts'

const sessionIdSchema = z.string().min(1).transform(value => value as SessionId)
const recentExchangeSchema = z.strictObject({
  turn: z.number().int().nonnegative(),
  prompt: z.string(),
  response: z.string(),
})
const optimizeReferenceSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  text: z.string().min(1),
})
const uiLocaleSchema = z.enum(['zh', 'en']).optional()
const optimizeRequestSchema = z.strictObject({
  operation: z.literal('optimize'),
  requestId: z.string(),
  sessionId: sessionIdSchema,
  source: z.string(),
  references: z.array(optimizeReferenceSchema),
  context: z.array(recentExchangeSchema),
  uiLocale: uiLocaleSchema,
})
const predictRequestSchema = z.strictObject({
  operation: z.literal('predict'),
  requestId: z.string(),
  sessionId: sessionIdSchema,
  context: z.array(recentExchangeSchema),
  uiLocale: uiLocaleSchema,
})
export const auxiliaryRequestSchema = z.discriminatedUnion('operation', [
  optimizeRequestSchema,
  predictRequestSchema,
])
export const rpcPayloadSchema = z.strictObject({
  method: z.literal('generate'),
  data: auxiliaryRequestSchema,
})
export type RpcPayload = z.infer<typeof rpcPayloadSchema>

const auxiliaryResultSchema = z.strictObject({
  requestId: z.string(),
  text: z.string(),
  route: z.strictObject({ provider: z.string(), model: z.string() }),
  segments: z.array(z.string()).optional(),
})

function codec(typeSymbol: string, schema: z.ZodType): TypertRemoteCodecSpec {
  return { mode: 'strict', typeSymbol, create: () => schema }
}

const payloadCodec = codec('dsh-agent-enhancer#RpcPayload', rpcPayloadSchema)
const resultCodec = codec(
  'dsh-agent-enhancer#AuxiliaryResult|null',
  z.union([auxiliaryResultSchema, z.null()]),
)

// Match Desktop session/modelCatalog wire shape: non-strict objects so adapter
// metadata extras do not fail Host result validation.
const modelReasoningEffortSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
})
const modelReasoningSchema = z.object({
  efforts: z.array(modelReasoningEffortSchema),
  defaultEffort: z.string().optional(),
})
const modelCatalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  reasoning: modelReasoningSchema.optional(),
})
const modelProviderGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(modelCatalogModelSchema),
})
const modelCatalogFailureSchema = z.object({
  id: z.string(),
  name: z.string(),
  message: z.string(),
})
export const modelCatalogSchema = z.object({
  default: z.object({
    provider: z.string(),
    model: z.string(),
    reasoningEffort: z.string().optional(),
  }),
  routableProviders: z.array(z.string()),
  groups: z.array(modelProviderGroupSchema),
  failures: z.array(modelCatalogFailureSchema),
})
export type ModelCatalogPayload = z.infer<typeof modelCatalogSchema>
const catalogCodec = codec('dsh-agent-enhancer#ModelCatalog', modelCatalogSchema)

const contextInspectCategorySchema = z.enum(['system', 'tools', 'messages'])
export const contextInspectRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  category: contextInspectCategorySchema,
})
const contextInspectKindSchema = z.enum([
  'system', 'tools', 'user', 'inject', 'assistant', 'tool', 'developer',
])
const contextInspectItemSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  body: z.string(),
  tokens: z.number().int().nonnegative(),
  kind: contextInspectKindSchema,
  replaced: z.boolean(),
})
const contextInspectPressureSchema = z.strictObject({
  projectedTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
})
const contextInspectEventKindSchema = z.enum(['compact', 'prune', 'replace'])
const contextInspectEventMarkSchema = z.strictObject({
  id: z.string(),
  kind: contextInspectEventKindSchema,
  seq: z.number().int().nonnegative(),
  shadowed: z.number().int().nonnegative(),
  title: z.string(),
})
const contextInspectResultSchema = z.strictObject({
  sessionId: sessionIdSchema,
  category: contextInspectCategorySchema,
  totalTokens: z.number().int().nonnegative(),
  approximate: z.literal(true),
  items: z.array(contextInspectItemSchema),
  pressure: contextInspectPressureSchema,
  events: z.array(contextInspectEventMarkSchema),
})
const contextInspectRequestCodec = codec('dsh-agent-enhancer#ContextInspectRequest', contextInspectRequestSchema)
const contextInspectResultCodec = codec('dsh-agent-enhancer#ContextInspectResult', contextInspectResultSchema)

export const contextCompactRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
const contextCompactResultSchema = z.strictObject({
  sessionId: sessionIdSchema,
  status: z.enum(['compacted', 'noop']),
  shadowedCount: z.number().int().nonnegative(),
  shadowedTokens: z.number().int().nonnegative(),
})
const contextCompactRequestCodec = codec('dsh-agent-enhancer#ContextCompactRequest', contextCompactRequestSchema)
const contextCompactResultCodec = codec('dsh-agent-enhancer#ContextCompactResult', contextCompactResultSchema)

export const deleteSessionRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
const deleteSessionCleanerReportSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string().optional(),
})
export const deleteSessionResultSchema = z.strictObject({
  ok: z.literal(true),
  sessionId: sessionIdSchema,
  unloaded: z.boolean(),
  hidden: z.boolean(),
  live: z.boolean(),
  removedPaths: z.array(z.string()),
  registry: z.strictObject({
    workspaces: z.array(z.string()),
    archived: z.boolean(),
    pinned: z.boolean(),
  }),
  pluginCleaners: z.array(deleteSessionCleanerReportSchema),
  detail: z.string(),
})
const deleteSessionRequestCodec = codec('dsh-agent-enhancer#DeleteSessionRequest', deleteSessionRequestSchema)
const deleteSessionResultCodec = codec('dsh-agent-enhancer#DeleteSessionResult', deleteSessionResultSchema)

export const readWorkspaceFileRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
})
export const readWorkspaceFileResultSchema = z.strictObject({
  path: z.string(),
  absolutePath: z.string(),
  text: z.string(),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
})
export const writeWorkspaceFileRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
  content: z.string(),
})
export const writeWorkspaceFileResultSchema = z.strictObject({
  path: z.string(),
  absolutePath: z.string(),
  bytes: z.number().int().nonnegative(),
})
const readWorkspaceFileRequestCodec = codec(
  'dsh-agent-enhancer#ReadWorkspaceFileRequest',
  readWorkspaceFileRequestSchema,
)
const readWorkspaceFileResultCodec = codec(
  'dsh-agent-enhancer#ReadWorkspaceFileResult',
  readWorkspaceFileResultSchema,
)
const writeWorkspaceFileRequestCodec = codec(
  'dsh-agent-enhancer#WriteWorkspaceFileRequest',
  writeWorkspaceFileRequestSchema,
)
const writeWorkspaceFileResultCodec = codec(
  'dsh-agent-enhancer#WriteWorkspaceFileResult',
  writeWorkspaceFileResultSchema,
)

const extraFolderRootSchema = z.strictObject({
  path: z.string().min(1),
  title: z.string().min(1),
})
export const listExtraFoldersRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
export const listExtraFoldersResultSchema = z.strictObject({
  primaryCwd: z.string().min(1),
  primaryTitle: z.string().min(1),
  roots: z.array(extraFolderRootSchema),
})
export const addExtraFolderRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
  title: z.string().min(1).optional(),
})
export const pickExtraFolderRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
export const pickExtraFolderResultSchema = z.strictObject({
  path: z.string().min(1).nullable(),
  primaryCwd: z.string().min(1),
  primaryTitle: z.string().min(1),
  roots: z.array(extraFolderRootSchema),
  added: z.boolean(),
})
export const removeExtraFolderRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
})
export const listExtraFolderEntriesRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  rootPath: z.string().min(1),
  relativePath: z.string().optional(),
})
export const listExtraFolderEntriesResultSchema = z.strictObject({
  rootPath: z.string().min(1),
  relativePath: z.string(),
  entries: z.array(z.strictObject({
    name: z.string().min(1),
    path: z.string(),
    absolutePath: z.string().min(1),
    kind: z.enum(['directory', 'file']),
  })),
})
const listExtraFoldersRequestCodec = codec(
  'dsh-agent-enhancer#ListExtraFoldersRequest',
  listExtraFoldersRequestSchema,
)
const listExtraFoldersResultCodec = codec(
  'dsh-agent-enhancer#ListExtraFoldersResult',
  listExtraFoldersResultSchema,
)
const addExtraFolderRequestCodec = codec(
  'dsh-agent-enhancer#AddExtraFolderRequest',
  addExtraFolderRequestSchema,
)
const pickExtraFolderRequestCodec = codec(
  'dsh-agent-enhancer#PickExtraFolderRequest',
  pickExtraFolderRequestSchema,
)
const pickExtraFolderResultCodec = codec(
  'dsh-agent-enhancer#PickExtraFolderResult',
  pickExtraFolderResultSchema,
)
const removeExtraFolderRequestCodec = codec(
  'dsh-agent-enhancer#RemoveExtraFolderRequest',
  removeExtraFolderRequestSchema,
)
const listExtraFolderEntriesRequestCodec = codec(
  'dsh-agent-enhancer#ListExtraFolderEntriesRequest',
  listExtraFolderEntriesRequestSchema,
)
const listExtraFolderEntriesResultCodec = codec(
  'dsh-agent-enhancer#ListExtraFolderEntriesResult',
  listExtraFolderEntriesResultSchema,
)

export const updateCheckResultSchema = z.strictObject({
  current: z.string(),
  latest: z.string().nullable(),
  updateAvailable: z.boolean(),
  installKind: z.enum(['npm', 'link', 'unknown']),
  canAutoApply: z.boolean(),
  command: z.string(),
})
export const applyUpdateResultSchema = z.strictObject({
  ok: z.boolean(),
  message: z.enum(APPLY_UPDATE_CODES),
  command: z.string().optional(),
})
const updateCheckResultCodec = codec('dsh-agent-enhancer#UpdateCheckResult', updateCheckResultSchema)
const applyUpdateResultCodec = codec('dsh-agent-enhancer#ApplyUpdateResult', applyUpdateResultSchema)

const usageTokenFields = {
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
}
const usageRangeSchema = z.enum(USAGE_RANGES)
const usageCallSchema = z.object({
  at: z.number().int().nonnegative(),
  source: z.enum(USAGE_SOURCES),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  ...usageTokenFields,
}).strict()
const usageModelLineSchema = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  calls: z.number().int().nonnegative(),
  ...usageTokenFields,
}).strict()
const usageSourceLineSchema = z.object({
  source: z.enum(USAGE_SOURCES),
  calls: z.number().int().nonnegative(),
  models: z.array(usageModelLineSchema),
  ...usageTokenFields,
}).strict()
const usageHeatCellSchema = z.object({
  key: z.string(),
  label: z.string(),
  at: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  calls: z.number().int().nonnegative(),
}).strict()
const usageHeatmapSchema = z.object({
  grain: z.enum(['hour', 'day']),
  cells: z.array(usageHeatCellSchema),
}).strict()
const usageMoneySchema = z.object({
  currency: z.literal('CNY'),
  estimatedCost: z.number().nonnegative(),
  pricedCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
}).strict()
const usageBalanceSchema = z.object({
  available: z.boolean(),
  currency: z.string(),
  total: z.string(),
  granted: z.string(),
  toppedUp: z.string(),
  checkedAt: z.number().int().nonnegative(),
  stale: z.boolean().optional(),
}).strict()
const usageBalanceStatusSchema = z.enum(['ready', 'no-key', 'unavailable'])
export const usageSummarySchema = z.object({
  range: usageRangeSchema,
  calls: z.number().int().nonnegative(),
  sources: z.array(usageSourceLineSchema),
  heatmap: usageHeatmapSchema,
  money: usageMoneySchema,
  balanceStatus: usageBalanceStatusSchema,
  balance: usageBalanceSchema.optional(),
  recent: z.array(usageCallSchema),
  ...usageTokenFields,
}).strict()
const providerBalanceStatusSchema = z.enum(['ready', 'no-key', 'signed-out', 'unavailable'])
const providerBalanceSnapshotSchema = z.object({
  source: z.enum(['account', 'api-key']),
  status: providerBalanceStatusSchema,
  balance: usageBalanceSchema.optional(),
}).strict()
export const providerBalancesSchema = z.object({
  account: providerBalanceSnapshotSchema,
  apiKey: providerBalanceSnapshotSchema,
}).strict()
export const providerBalancesRequestSchema = z.object({
  force: z.boolean().optional(),
  locale: z.string().optional(),
}).strict()
const usageRangeCodec = codec('dsh-agent-enhancer#UsageRange', usageRangeSchema)
const usageSummaryCodec = codec('dsh-agent-enhancer#UsageSummary', usageSummarySchema)
const providerBalancesCodec = codec('dsh-agent-enhancer#ProviderBalances', providerBalancesSchema)
const providerBalancesRequestCodec = codec(
  'dsh-agent-enhancer#ProviderBalancesRequest',
  providerBalancesRequestSchema,
)

export const softPauseSnapshotRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
export type SoftPauseSnapshotRequest = z.infer<typeof softPauseSnapshotRequestSchema>
export const softPauseSetRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  engaged: z.boolean(),
})
export type SoftPauseSetRequest = z.infer<typeof softPauseSetRequestSchema>
export const softPauseStateSchema = z.strictObject({
  sessionId: sessionIdSchema,
  engaged: z.boolean(),
})
export type SoftPauseState = z.infer<typeof softPauseStateSchema>
const softPauseSnapshotRequestCodec = codec(
  'dsh-agent-enhancer#SoftPauseSnapshotRequest',
  softPauseSnapshotRequestSchema,
)
const softPauseSetRequestCodec = codec(
  'dsh-agent-enhancer#SoftPauseSetRequest',
  softPauseSetRequestSchema,
)
const softPauseStateCodec = codec('dsh-agent-enhancer#SoftPauseState', softPauseStateSchema)

export const showOsNotificationRequestSchema = z.strictObject({
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(240),
  tag: z.string().max(120).optional(),
})
export type ShowOsNotificationRequest = z.infer<typeof showOsNotificationRequestSchema>
export const showOsNotificationResultSchema = z.strictObject({
  shown: z.boolean(),
  channel: z.enum(['electron', 'windows', 'none']),
})
export type ShowOsNotificationResult = z.infer<typeof showOsNotificationResultSchema>
const showOsNotificationRequestCodec = codec(
  'dsh-agent-enhancer#ShowOsNotificationRequest',
  showOsNotificationRequestSchema,
)
const showOsNotificationResultCodec = codec(
  'dsh-agent-enhancer#ShowOsNotificationResult',
  showOsNotificationResultSchema,
)

export const browserAgentApprovalDecisionSchema = z.enum(['allow-once', 'allow-origin', 'deny'])
export type BrowserAgentApprovalDecisionWire = z.infer<typeof browserAgentApprovalDecisionSchema>

export const browserAgentPendingSchema = z.strictObject({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().optional(),
  origin: z.string().optional(),
})
export type BrowserAgentPendingWire = z.infer<typeof browserAgentPendingSchema>

export const browserAgentTabConflictSchema = z.strictObject({
  sessionId: z.string().min(1),
  boundTabId: z.number().int(),
  activeTabId: z.number().int(),
})
export type BrowserAgentTabConflictWire = z.infer<typeof browserAgentTabConflictSchema>

export const browserAgentNeedsHumanSchema = z.strictObject({
  sessionId: z.string().min(1),
  detail: z.string().min(1),
})
export type BrowserAgentNeedsHumanWire = z.infer<typeof browserAgentNeedsHumanSchema>

export const browserAgentAuditEntrySchema = z.strictObject({
  at: z.number(),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  summary: z.string().min(1),
  url: z.string().optional(),
  outcome: z.enum(['ok', 'denied', 'error', 'needs_human']),
})
export type BrowserAgentAuditEntryWire = z.infer<typeof browserAgentAuditEntrySchema>

export const browserAgentSnapshotSchema = z.strictObject({
  enabled: z.boolean(),
  /** Settings preference (auto / chrome / edge). */
  browser: z.enum(['auto', 'chrome', 'edge']),
  /** Actually launched channel once ready; null when not running. */
  launchedBrowser: z.enum(['chrome', 'edge']).nullable(),
  /** Shipping driver (Playwright only after MV3 retirement). */
  driver: z.literal('playwright'),
  allowedOrigins: z.array(z.string()),
  /** Connection status (field name kept for client compatibility). */
  bridge: z.strictObject({
    listening: z.boolean(),
    port: z.number().int(),
    extensionConnected: z.boolean(),
    lastError: z.string().nullable(),
  }),
  pending: browserAgentPendingSchema.nullable(),
  tabConflict: browserAgentTabConflictSchema.nullable(),
  needsHuman: browserAgentNeedsHumanSchema.nullable(),
  boundTabId: z.number().int().nullable(),
  audit: z.array(browserAgentAuditEntrySchema),
  /** Dedicated Chromium profile used by one-click launch (user-level). */
  profileDir: z.string().min(1),
})
export type BrowserAgentSnapshot = z.infer<typeof browserAgentSnapshotSchema>
const browserAgentSnapshotCodec = codec(
  'dsh-agent-enhancer#BrowserAgentSnapshot',
  browserAgentSnapshotSchema,
)

export const browserAgentResolveRequestSchema = z.strictObject({
  id: z.string().min(1),
  decision: browserAgentApprovalDecisionSchema,
})
export type BrowserAgentResolveRequest = z.infer<typeof browserAgentResolveRequestSchema>
const browserAgentResolveRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentResolveRequest',
  browserAgentResolveRequestSchema,
)

export const browserAgentResolveResultSchema = z.strictObject({
  ok: z.boolean(),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentResolveResult = z.infer<typeof browserAgentResolveResultSchema>
const browserAgentResolveResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentResolveResult',
  browserAgentResolveResultSchema,
)

export const browserAgentResolveTabConflictRequestSchema = z.strictObject({
  decision: z.enum(['follow', 'stay']),
})
export type BrowserAgentResolveTabConflictRequest = z.infer<typeof browserAgentResolveTabConflictRequestSchema>
const browserAgentResolveTabConflictRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentResolveTabConflictRequest',
  browserAgentResolveTabConflictRequestSchema,
)

export const browserAgentResolveTabConflictResultSchema = z.strictObject({
  ok: z.boolean(),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentResolveTabConflictResult = z.infer<typeof browserAgentResolveTabConflictResultSchema>
const browserAgentResolveTabConflictResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentResolveTabConflictResult',
  browserAgentResolveTabConflictResultSchema,
)

export const browserAgentAcknowledgeHumanRequestSchema = z.strictObject({
  sessionId: z.string().min(1).optional(),
})
export type BrowserAgentAcknowledgeHumanRequest = z.infer<typeof browserAgentAcknowledgeHumanRequestSchema>
const browserAgentAcknowledgeHumanRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentAcknowledgeHumanRequest',
  browserAgentAcknowledgeHumanRequestSchema,
)

export const browserAgentAcknowledgeHumanResultSchema = z.strictObject({
  ok: z.boolean(),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentAcknowledgeHumanResult = z.infer<typeof browserAgentAcknowledgeHumanResultSchema>
const browserAgentAcknowledgeHumanResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentAcknowledgeHumanResult',
  browserAgentAcknowledgeHumanResultSchema,
)

export const browserAgentOpenUrlRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
  url: z.string().min(1),
})
export type BrowserAgentOpenUrlRequest = z.infer<typeof browserAgentOpenUrlRequestSchema>
const browserAgentOpenUrlRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentOpenUrlRequest',
  browserAgentOpenUrlRequestSchema,
)

export const browserAgentOpenUrlResultSchema = z.strictObject({
  ok: z.boolean(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentOpenUrlResult = z.infer<typeof browserAgentOpenUrlResultSchema>
const browserAgentOpenUrlResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentOpenUrlResult',
  browserAgentOpenUrlResultSchema,
)

export const browserAgentQuotePageRequestSchema = z.strictObject({
  sessionId: z.string().min(1),
})
export type BrowserAgentQuotePageRequest = z.infer<typeof browserAgentQuotePageRequestSchema>
const browserAgentQuotePageRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentQuotePageRequest',
  browserAgentQuotePageRequestSchema,
)

export const browserAgentQuotePageResultSchema = z.strictObject({
  ok: z.boolean(),
  text: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  error: z.string().optional(),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentQuotePageResult = z.infer<typeof browserAgentQuotePageResultSchema>
const browserAgentQuotePageResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentQuotePageResult',
  browserAgentQuotePageResultSchema,
)

export const browserAgentLaunchBrowserRequestSchema = z.strictObject({
  browser: z.enum(['auto', 'chrome', 'edge']).optional(),
})
export type BrowserAgentLaunchBrowserRequest = z.infer<typeof browserAgentLaunchBrowserRequestSchema>
const browserAgentLaunchBrowserRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentLaunchBrowserRequest',
  browserAgentLaunchBrowserRequestSchema,
)

export const browserAgentLaunchBrowserResultSchema = z.strictObject({
  ok: z.boolean(),
  browser: z.enum(['chrome', 'edge']).optional(),
  executable: z.string().optional(),
  profileDir: z.string().min(1),
  error: z.string().optional(),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentLaunchBrowserResult = z.infer<typeof browserAgentLaunchBrowserResultSchema>
const browserAgentLaunchBrowserResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentLaunchBrowserResult',
  browserAgentLaunchBrowserResultSchema,
)

/** Immediate live preference sync (sidebar select) so Agent tools do not wait on Cordis. */
export const browserAgentSetBrowserRequestSchema = z.strictObject({
  browser: z.enum(['auto', 'chrome', 'edge']),
})
export type BrowserAgentSetBrowserRequest = z.infer<typeof browserAgentSetBrowserRequestSchema>
const browserAgentSetBrowserRequestCodec = codec(
  'dsh-agent-enhancer#BrowserAgentSetBrowserRequest',
  browserAgentSetBrowserRequestSchema,
)

export const browserAgentSetBrowserResultSchema = z.strictObject({
  ok: z.boolean(),
  browser: z.enum(['auto', 'chrome', 'edge']),
  snapshot: browserAgentSnapshotSchema,
})
export type BrowserAgentSetBrowserResult = z.infer<typeof browserAgentSetBrowserResultSchema>
const browserAgentSetBrowserResultCodec = codec(
  'dsh-agent-enhancer#BrowserAgentSetBrowserResult',
  browserAgentSetBrowserResultSchema,
)

const instructionScopeSchema = z.enum(['global', 'shared', 'project'])
const instructionFileEntrySchema = z.strictObject({
  id: z.string().min(1),
  scope: instructionScopeSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  exists: z.boolean(),
  bytes: z.number().int().nonnegative().nullable(),
  createable: z.boolean(),
})
const skillInstallChannelSchema = z.enum(['github', 'zip', 'unknown'])
const skillCatalogEntrySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  path: z.string().min(1).nullable(),
  provider: z.string(),
  modelInvocable: z.boolean().nullable(),
  userInvocable: z.boolean().nullable(),
  removable: z.boolean(),
  installChannel: skillInstallChannelSchema.nullable(),
  updateAvailable: z.boolean(),
  updateSourceLabel: z.string().nullable(),
  updateCheckFailed: z.boolean(),
})
export const listInstructionsSkillsRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  checkUpdates: z.boolean().optional(),
})
export type ListInstructionsSkillsRequest = z.infer<typeof listInstructionsSkillsRequestSchema>
export const instructionsSkillsSnapshotSchema = z.strictObject({
  sessionId: sessionIdSchema,
  cwd: z.string().min(1),
  projectRoot: z.string().min(1),
  instructions: z.array(instructionFileEntrySchema),
  skills: z.array(skillCatalogEntrySchema),
  skillsSource: z.enum(['registry', 'filesystem', 'merged']),
})
export type InstructionsSkillsSnapshot = z.infer<typeof instructionsSkillsSnapshotSchema>
export const createWorkspaceAgentsRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
export type CreateWorkspaceAgentsRequest = z.infer<typeof createWorkspaceAgentsRequestSchema>
export const createWorkspaceAgentsResultSchema = z.strictObject({
  path: z.string().min(1),
  created: z.boolean(),
  snapshot: instructionsSkillsSnapshotSchema,
})
export type CreateWorkspaceAgentsResult = z.infer<typeof createWorkspaceAgentsResultSchema>
export const createWorkspaceSkillRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1),
})
export type CreateWorkspaceSkillRequest = z.infer<typeof createWorkspaceSkillRequestSchema>
export const createWorkspaceSkillResultSchema = z.strictObject({
  path: z.string().min(1),
  created: z.boolean(),
  snapshot: instructionsSkillsSnapshotSchema,
})
export type CreateWorkspaceSkillResult = z.infer<typeof createWorkspaceSkillResultSchema>
const listInstructionsSkillsRequestCodec = codec(
  'dsh-agent-enhancer#ListInstructionsSkillsRequest',
  listInstructionsSkillsRequestSchema,
)
const instructionsSkillsSnapshotCodec = codec(
  'dsh-agent-enhancer#InstructionsSkillsSnapshot',
  instructionsSkillsSnapshotSchema,
)
const createWorkspaceAgentsRequestCodec = codec(
  'dsh-agent-enhancer#CreateWorkspaceAgentsRequest',
  createWorkspaceAgentsRequestSchema,
)
const createWorkspaceAgentsResultCodec = codec(
  'dsh-agent-enhancer#CreateWorkspaceAgentsResult',
  createWorkspaceAgentsResultSchema,
)
const createWorkspaceSkillRequestCodec = codec(
  'dsh-agent-enhancer#CreateWorkspaceSkillRequest',
  createWorkspaceSkillRequestSchema,
)
const createWorkspaceSkillResultCodec = codec(
  'dsh-agent-enhancer#CreateWorkspaceSkillResult',
  createWorkspaceSkillResultSchema,
)

const skillInstallTargetSchema = z.enum(['user', 'user-dsh', 'project', 'project-dsh'])
const skillInstallModeSchema = z.enum(['link', 'copy'])
const installedSkillRefSchema = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  mode: skillInstallModeSchema,
})
export const installSkillFromGitRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  source: z.string().min(1),
  target: skillInstallTargetSchema,
  force: z.boolean().optional(),
})
export type InstallSkillFromGitRequest = z.infer<typeof installSkillFromGitRequestSchema>
export const installSkillFromGitResultSchema = z.strictObject({
  installed: z.array(installedSkillRefSchema),
  skippedBusy: z.array(z.string().min(1)).default([]),
  snapshot: instructionsSkillsSnapshotSchema,
})
export type InstallSkillFromGitResult = z.infer<typeof installSkillFromGitResultSchema>
export const installSkillFromZipRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  zipPath: z.string().min(1).optional(),
  target: skillInstallTargetSchema,
  force: z.boolean().optional(),
})
export type InstallSkillFromZipRequest = z.infer<typeof installSkillFromZipRequestSchema>
export const installSkillFromZipResultSchema = z.strictObject({
  cancelled: z.boolean(),
  installed: z.array(installedSkillRefSchema),
  zipPath: z.string().min(1).nullable(),
  snapshot: instructionsSkillsSnapshotSchema,
})
export type InstallSkillFromZipResult = z.infer<typeof installSkillFromZipResultSchema>
export const uninstallSkillRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1),
  path: z.string().min(1),
})
export type UninstallSkillRequest = z.infer<typeof uninstallSkillRequestSchema>
export const uninstallSkillResultSchema = z.strictObject({
  name: z.string().min(1),
  removedPath: z.string().min(1),
  snapshot: instructionsSkillsSnapshotSchema,
})
export type UninstallSkillResult = z.infer<typeof uninstallSkillResultSchema>
export const updateSkillFromGitRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  name: z.string().min(1),
})
export type UpdateSkillFromGitRequest = z.infer<typeof updateSkillFromGitRequestSchema>
export const updateSkillFromGitResultSchema = z.strictObject({
  updated: installedSkillRefSchema,
  snapshot: instructionsSkillsSnapshotSchema,
})
export type UpdateSkillFromGitResult = z.infer<typeof updateSkillFromGitResultSchema>
export const readSkillDocumentRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  path: z.string().min(1),
})
export type ReadSkillDocumentRequest = z.infer<typeof readSkillDocumentRequestSchema>
export const readSkillDocumentResultSchema = z.strictObject({
  path: z.string().min(1),
  absolutePath: z.string().min(1),
  text: z.string(),
  bytes: z.number().int().nonnegative(),
})
export type ReadSkillDocumentResult = z.infer<typeof readSkillDocumentResultSchema>
export const getSkillInstallProgressRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
export type GetSkillInstallProgressRequest = z.infer<typeof getSkillInstallProgressRequestSchema>
export const getSkillInstallProgressResultSchema = z.strictObject({
  sessionId: z.string(),
  stage: z.enum(SKILL_INSTALL_STAGES),
  detail: z.string().nullable(),
  bytesReceived: z.number().nonnegative().nullable(),
  bytesTotal: z.number().positive().nullable(),
  startedAt: z.number().nonnegative().nullable(),
})
export type GetSkillInstallProgressResult = z.infer<typeof getSkillInstallProgressResultSchema>
const installSkillFromGitRequestCodec = codec(
  'dsh-agent-enhancer#InstallSkillFromGitRequest',
  installSkillFromGitRequestSchema,
)
const installSkillFromGitResultCodec = codec(
  'dsh-agent-enhancer#InstallSkillFromGitResult',
  installSkillFromGitResultSchema,
)
const uninstallSkillRequestCodec = codec(
  'dsh-agent-enhancer#UninstallSkillRequest',
  uninstallSkillRequestSchema,
)
const uninstallSkillResultCodec = codec(
  'dsh-agent-enhancer#UninstallSkillResult',
  uninstallSkillResultSchema,
)
const installSkillFromZipRequestCodec = codec(
  'dsh-agent-enhancer#InstallSkillFromZipRequest',
  installSkillFromZipRequestSchema,
)
const installSkillFromZipResultCodec = codec(
  'dsh-agent-enhancer#InstallSkillFromZipResult',
  installSkillFromZipResultSchema,
)
const updateSkillFromGitRequestCodec = codec(
  'dsh-agent-enhancer#UpdateSkillFromGitRequest',
  updateSkillFromGitRequestSchema,
)
const updateSkillFromGitResultCodec = codec(
  'dsh-agent-enhancer#UpdateSkillFromGitResult',
  updateSkillFromGitResultSchema,
)
const readSkillDocumentRequestCodec = codec(
  'dsh-agent-enhancer#ReadSkillDocumentRequest',
  readSkillDocumentRequestSchema,
)
const readSkillDocumentResultCodec = codec(
  'dsh-agent-enhancer#ReadSkillDocumentResult',
  readSkillDocumentResultSchema,
)
const getSkillInstallProgressRequestCodec = codec(
  'dsh-agent-enhancer#GetSkillInstallProgressRequest',
  getSkillInstallProgressRequestSchema,
)
const getSkillInstallProgressResultCodec = codec(
  'dsh-agent-enhancer#GetSkillInstallProgressResult',
  getSkillInstallProgressResultSchema,
)

const mcpInstallChannelSchema = z.enum(['manual', 'npx', 'github', 'mcpJson'])
const mcpStdioTransportSchema = z.strictObject({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: z.string(),
})
const mcpHttpTransportSchema = z.strictObject({
  transport: z.literal('streamable-http'),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
})
const mcpTransportSchema = z.discriminatedUnion('transport', [
  mcpStdioTransportSchema,
  mcpHttpTransportSchema,
])
const mcpConnectorEntrySchema = z.strictObject({
  id: z.string().min(1),
  serverName: z.string().min(1),
  enabled: z.boolean(),
  channel: mcpInstallChannelSchema,
  sourceLabel: z.string().nullable(),
  transport: mcpTransportSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
})
export const mcpConnectorsSnapshotSchema = z.strictObject({
  connectors: z.array(mcpConnectorEntrySchema),
  bridgeAvailable: z.boolean(),
  bridgeError: z.string().nullable(),
})
export type McpConnectorsSnapshotWire = z.infer<typeof mcpConnectorsSnapshotSchema>
export const listMcpConnectorsRequestSchema = z.strictObject({})
export type ListMcpConnectorsRequestWire = z.infer<typeof listMcpConnectorsRequestSchema>
export const upsertMcpConnectorRequestSchema = z.strictObject({
  id: z.string().min(1).optional(),
  serverName: z.string().min(1),
  enabled: z.boolean().optional(),
  channel: mcpInstallChannelSchema.optional(),
  sourceLabel: z.string().nullable().optional(),
  transport: mcpTransportSchema,
})
export type UpsertMcpConnectorRequestWire = z.infer<typeof upsertMcpConnectorRequestSchema>
export const upsertMcpConnectorResultSchema = z.strictObject({
  connector: mcpConnectorEntrySchema,
  snapshot: mcpConnectorsSnapshotSchema,
})
export type UpsertMcpConnectorResultWire = z.infer<typeof upsertMcpConnectorResultSchema>
export const setMcpConnectorEnabledRequestSchema = z.strictObject({
  id: z.string().min(1),
  enabled: z.boolean(),
})
export type SetMcpConnectorEnabledRequestWire = z.infer<typeof setMcpConnectorEnabledRequestSchema>
export const setMcpConnectorEnabledResultSchema = z.strictObject({
  connector: mcpConnectorEntrySchema,
  snapshot: mcpConnectorsSnapshotSchema,
})
export type SetMcpConnectorEnabledResultWire = z.infer<typeof setMcpConnectorEnabledResultSchema>
export const uninstallMcpConnectorRequestSchema = z.strictObject({
  id: z.string().min(1),
})
export type UninstallMcpConnectorRequestWire = z.infer<typeof uninstallMcpConnectorRequestSchema>
export const uninstallMcpConnectorResultSchema = z.strictObject({
  id: z.string().min(1),
  snapshot: mcpConnectorsSnapshotSchema,
})
export type UninstallMcpConnectorResultWire = z.infer<typeof uninstallMcpConnectorResultSchema>
export const installMcpFromNpxRequestSchema = z.strictObject({
  serverName: z.string().min(1),
  packageName: z.string().min(1),
  extraArgs: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  force: z.boolean().optional(),
})
export type InstallMcpFromNpxRequestWire = z.infer<typeof installMcpFromNpxRequestSchema>
export const installMcpFromNpxResultSchema = z.strictObject({
  connector: mcpConnectorEntrySchema,
  snapshot: mcpConnectorsSnapshotSchema,
})
export type InstallMcpFromNpxResultWire = z.infer<typeof installMcpFromNpxResultSchema>
export const installMcpFromGitRequestSchema = z.strictObject({
  serverName: z.string().min(1),
  source: z.string().min(1),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
  force: z.boolean().optional(),
})
export type InstallMcpFromGitRequestWire = z.infer<typeof installMcpFromGitRequestSchema>
export const installMcpFromGitResultSchema = z.strictObject({
  connector: mcpConnectorEntrySchema,
  snapshot: mcpConnectorsSnapshotSchema,
})
export type InstallMcpFromGitResultWire = z.infer<typeof installMcpFromGitResultSchema>
export const importMcpJsonRequestSchema = z.strictObject({
  jsonText: z.string().min(1),
  enabled: z.boolean().optional(),
  force: z.boolean().optional(),
})
export type ImportMcpJsonRequestWire = z.infer<typeof importMcpJsonRequestSchema>
export const importMcpJsonResultSchema = z.strictObject({
  imported: z.array(mcpConnectorEntrySchema),
  skipped: z.array(z.string()),
  snapshot: mcpConnectorsSnapshotSchema,
})
export type ImportMcpJsonResultWire = z.infer<typeof importMcpJsonResultSchema>
export const listMcpConnectorToolsRequestSchema = z.strictObject({
  serverName: z.string().min(1),
})
export type ListMcpConnectorToolsRequestWire = z.infer<typeof listMcpConnectorToolsRequestSchema>
export const listMcpConnectorToolsResultSchema = z.strictObject({
  serverName: z.string().min(1),
  tools: z.array(z.strictObject({
    name: z.string().min(1),
    description: z.string(),
  })),
})
export type ListMcpConnectorToolsResultWire = z.infer<typeof listMcpConnectorToolsResultSchema>

const listMcpConnectorsRequestCodec = codec(
  'dsh-agent-enhancer#ListMcpConnectorsRequest',
  listMcpConnectorsRequestSchema,
)
const mcpConnectorsSnapshotCodec = codec(
  'dsh-agent-enhancer#McpConnectorsSnapshot',
  mcpConnectorsSnapshotSchema,
)
const upsertMcpConnectorRequestCodec = codec(
  'dsh-agent-enhancer#UpsertMcpConnectorRequest',
  upsertMcpConnectorRequestSchema,
)
const upsertMcpConnectorResultCodec = codec(
  'dsh-agent-enhancer#UpsertMcpConnectorResult',
  upsertMcpConnectorResultSchema,
)
const setMcpConnectorEnabledRequestCodec = codec(
  'dsh-agent-enhancer#SetMcpConnectorEnabledRequest',
  setMcpConnectorEnabledRequestSchema,
)
const setMcpConnectorEnabledResultCodec = codec(
  'dsh-agent-enhancer#SetMcpConnectorEnabledResult',
  setMcpConnectorEnabledResultSchema,
)
const uninstallMcpConnectorRequestCodec = codec(
  'dsh-agent-enhancer#UninstallMcpConnectorRequest',
  uninstallMcpConnectorRequestSchema,
)
const uninstallMcpConnectorResultCodec = codec(
  'dsh-agent-enhancer#UninstallMcpConnectorResult',
  uninstallMcpConnectorResultSchema,
)
const installMcpFromNpxRequestCodec = codec(
  'dsh-agent-enhancer#InstallMcpFromNpxRequest',
  installMcpFromNpxRequestSchema,
)
const installMcpFromNpxResultCodec = codec(
  'dsh-agent-enhancer#InstallMcpFromNpxResult',
  installMcpFromNpxResultSchema,
)
const installMcpFromGitRequestCodec = codec(
  'dsh-agent-enhancer#InstallMcpFromGitRequest',
  installMcpFromGitRequestSchema,
)
const installMcpFromGitResultCodec = codec(
  'dsh-agent-enhancer#InstallMcpFromGitResult',
  installMcpFromGitResultSchema,
)
const importMcpJsonRequestCodec = codec(
  'dsh-agent-enhancer#ImportMcpJsonRequest',
  importMcpJsonRequestSchema,
)
const importMcpJsonResultCodec = codec(
  'dsh-agent-enhancer#ImportMcpJsonResult',
  importMcpJsonResultSchema,
)
const listMcpConnectorToolsRequestCodec = codec(
  'dsh-agent-enhancer#ListMcpConnectorToolsRequest',
  listMcpConnectorToolsRequestSchema,
)
const listMcpConnectorToolsResultCodec = codec(
  'dsh-agent-enhancer#ListMcpConnectorToolsResult',
  listMcpConnectorToolsResultSchema,
)

export const remoteInfo = createTypertRemoteInfo({
  package: 'dsh-agent-enhancer',
  methods: {
    'agentEnhancer/call': {
      service: 'agentEnhancer',
      implementation: 'call',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'payload',
        source: 'json',
        codec: payloadCodec,
        strictCodec: payloadCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: resultCodec,
    },
    // Same shape as session/modelCatalog: no cancellation parameter.
    'agentEnhancer/listCatalog': {
      service: 'agentEnhancer',
      implementation: 'listCatalog',
      invocation: { kind: 'direct' },
      parameters: [],
      result: catalogCodec,
    },
    'agentEnhancer/inspectContext': {
      service: 'agentEnhancer',
      implementation: 'inspectContext',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: contextInspectRequestCodec,
        strictCodec: contextInspectRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: contextInspectResultCodec,
    },
    'agentEnhancer/compactContext': {
      service: 'agentEnhancer',
      implementation: 'compactContext',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: contextCompactRequestCodec,
        strictCodec: contextCompactRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: contextCompactResultCodec,
    },
    'agentEnhancer/deleteSession': {
      service: 'agentEnhancer',
      implementation: 'deleteSession',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: deleteSessionRequestCodec,
        strictCodec: deleteSessionRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: deleteSessionResultCodec,
    },
    'agentEnhancer/readWorkspaceFile': {
      service: 'agentEnhancer',
      implementation: 'readWorkspaceFile',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: readWorkspaceFileRequestCodec,
        strictCodec: readWorkspaceFileRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: readWorkspaceFileResultCodec,
    },
    'agentEnhancer/writeWorkspaceFile': {
      service: 'agentEnhancer',
      implementation: 'writeWorkspaceFile',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: writeWorkspaceFileRequestCodec,
        strictCodec: writeWorkspaceFileRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: writeWorkspaceFileResultCodec,
    },
    'agentEnhancer/listExtraFolders': {
      service: 'agentEnhancer',
      implementation: 'listExtraFolders',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: listExtraFoldersRequestCodec,
        strictCodec: listExtraFoldersRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: listExtraFoldersResultCodec,
    },
    'agentEnhancer/addExtraFolder': {
      service: 'agentEnhancer',
      implementation: 'addExtraFolder',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: addExtraFolderRequestCodec,
        strictCodec: addExtraFolderRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: listExtraFoldersResultCodec,
    },
    'agentEnhancer/pickExtraFolder': {
      service: 'agentEnhancer',
      implementation: 'pickExtraFolder',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: pickExtraFolderRequestCodec,
        strictCodec: pickExtraFolderRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: pickExtraFolderResultCodec,
    },
    'agentEnhancer/removeExtraFolder': {
      service: 'agentEnhancer',
      implementation: 'removeExtraFolder',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: removeExtraFolderRequestCodec,
        strictCodec: removeExtraFolderRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: listExtraFoldersResultCodec,
    },
    'agentEnhancer/listExtraFolderEntries': {
      service: 'agentEnhancer',
      implementation: 'listExtraFolderEntries',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: listExtraFolderEntriesRequestCodec,
        strictCodec: listExtraFolderEntriesRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: listExtraFolderEntriesResultCodec,
    },
    'agentEnhancer/checkUpdate': {
      service: 'agentEnhancer',
      implementation: 'checkUpdate',
      invocation: { kind: 'direct' },
      parameters: [],
      result: updateCheckResultCodec,
    },
    'agentEnhancer/applyUpdate': {
      service: 'agentEnhancer',
      implementation: 'applyUpdate',
      invocation: { kind: 'direct' },
      parameters: [],
      result: applyUpdateResultCodec,
    },
    'agentEnhancer/usageSummary': {
      service: 'agentEnhancer',
      implementation: 'usageSummary',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'range',
        source: 'json',
        codec: usageRangeCodec,
        strictCodec: usageRangeCodec,
      }],
      result: usageSummaryCodec,
    },
    'agentEnhancer/providerBalances': {
      service: 'agentEnhancer',
      implementation: 'providerBalances',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: providerBalancesRequestCodec,
        strictCodec: providerBalancesRequestCodec,
      }],
      result: providerBalancesCodec,
    },
    'agentEnhancer/softPauseSnapshot': {
      service: 'agentEnhancer',
      implementation: 'softPauseSnapshot',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: softPauseSnapshotRequestCodec,
        strictCodec: softPauseSnapshotRequestCodec,
      }],
      result: softPauseStateCodec,
    },
    'agentEnhancer/softPauseSet': {
      service: 'agentEnhancer',
      implementation: 'softPauseSet',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: softPauseSetRequestCodec,
        strictCodec: softPauseSetRequestCodec,
      }],
      result: softPauseStateCodec,
    },
    'agentEnhancer/showOsNotification': {
      service: 'agentEnhancer',
      implementation: 'showOsNotification',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: showOsNotificationRequestCodec,
        strictCodec: showOsNotificationRequestCodec,
      }],
      result: showOsNotificationResultCodec,
    },
    'agentEnhancer/browserAgentSnapshot': {
      service: 'agentEnhancer',
      implementation: 'browserAgentSnapshot',
      invocation: { kind: 'direct' },
      parameters: [],
      result: browserAgentSnapshotCodec,
    },
    'agentEnhancer/browserAgentResolve': {
      service: 'agentEnhancer',
      implementation: 'browserAgentResolve',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentResolveRequestCodec,
        strictCodec: browserAgentResolveRequestCodec,
      }],
      result: browserAgentResolveResultCodec,
    },
    'agentEnhancer/browserAgentResolveTabConflict': {
      service: 'agentEnhancer',
      implementation: 'browserAgentResolveTabConflict',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentResolveTabConflictRequestCodec,
        strictCodec: browserAgentResolveTabConflictRequestCodec,
      }],
      result: browserAgentResolveTabConflictResultCodec,
    },
    'agentEnhancer/browserAgentAcknowledgeHuman': {
      service: 'agentEnhancer',
      implementation: 'browserAgentAcknowledgeHuman',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentAcknowledgeHumanRequestCodec,
        strictCodec: browserAgentAcknowledgeHumanRequestCodec,
      }],
      result: browserAgentAcknowledgeHumanResultCodec,
    },
    'agentEnhancer/browserAgentOpenUrl': {
      service: 'agentEnhancer',
      implementation: 'browserAgentOpenUrl',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentOpenUrlRequestCodec,
        strictCodec: browserAgentOpenUrlRequestCodec,
      }],
      result: browserAgentOpenUrlResultCodec,
    },
    'agentEnhancer/browserAgentQuotePage': {
      service: 'agentEnhancer',
      implementation: 'browserAgentQuotePage',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentQuotePageRequestCodec,
        strictCodec: browserAgentQuotePageRequestCodec,
      }],
      result: browserAgentQuotePageResultCodec,
    },
    'agentEnhancer/browserAgentLaunchBrowser': {
      service: 'agentEnhancer',
      implementation: 'browserAgentLaunchBrowser',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentLaunchBrowserRequestCodec,
        strictCodec: browserAgentLaunchBrowserRequestCodec,
      }],
      result: browserAgentLaunchBrowserResultCodec,
    },
    'agentEnhancer/browserAgentSetBrowser': {
      service: 'agentEnhancer',
      implementation: 'browserAgentSetBrowser',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: browserAgentSetBrowserRequestCodec,
        strictCodec: browserAgentSetBrowserRequestCodec,
      }],
      result: browserAgentSetBrowserResultCodec,
    },
    'agentEnhancer/listInstructionsSkills': {
      service: 'agentEnhancer',
      implementation: 'listInstructionsSkills',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: listInstructionsSkillsRequestCodec,
        strictCodec: listInstructionsSkillsRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: instructionsSkillsSnapshotCodec,
    },
    'agentEnhancer/createWorkspaceAgents': {
      service: 'agentEnhancer',
      implementation: 'createWorkspaceAgents',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: createWorkspaceAgentsRequestCodec,
        strictCodec: createWorkspaceAgentsRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: createWorkspaceAgentsResultCodec,
    },
    'agentEnhancer/createWorkspaceSkill': {
      service: 'agentEnhancer',
      implementation: 'createWorkspaceSkill',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: createWorkspaceSkillRequestCodec,
        strictCodec: createWorkspaceSkillRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: createWorkspaceSkillResultCodec,
    },
    'agentEnhancer/installSkillFromGit': {
      service: 'agentEnhancer',
      implementation: 'installSkillFromGit',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: installSkillFromGitRequestCodec,
        strictCodec: installSkillFromGitRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: installSkillFromGitResultCodec,
    },
    'agentEnhancer/uninstallSkill': {
      service: 'agentEnhancer',
      implementation: 'uninstallSkill',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: uninstallSkillRequestCodec,
        strictCodec: uninstallSkillRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: uninstallSkillResultCodec,
    },
    'agentEnhancer/installSkillFromZip': {
      service: 'agentEnhancer',
      implementation: 'installSkillFromZip',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: installSkillFromZipRequestCodec,
        strictCodec: installSkillFromZipRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: installSkillFromZipResultCodec,
    },
    'agentEnhancer/updateSkillFromGit': {
      service: 'agentEnhancer',
      implementation: 'updateSkillFromGit',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: updateSkillFromGitRequestCodec,
        strictCodec: updateSkillFromGitRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: updateSkillFromGitResultCodec,
    },
    'agentEnhancer/readSkillDocument': {
      service: 'agentEnhancer',
      implementation: 'readSkillDocument',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: readSkillDocumentRequestCodec,
        strictCodec: readSkillDocumentRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: readSkillDocumentResultCodec,
    },
    'agentEnhancer/getSkillInstallProgress': {
      service: 'agentEnhancer',
      implementation: 'getSkillInstallProgress',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: getSkillInstallProgressRequestCodec,
        strictCodec: getSkillInstallProgressRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: getSkillInstallProgressResultCodec,
    },
    'agentEnhancer/listMcpConnectors': {
      service: 'agentEnhancer',
      implementation: 'listMcpConnectors',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: listMcpConnectorsRequestCodec,
        strictCodec: listMcpConnectorsRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: mcpConnectorsSnapshotCodec,
    },
    'agentEnhancer/upsertMcpConnector': {
      service: 'agentEnhancer',
      implementation: 'upsertMcpConnector',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: upsertMcpConnectorRequestCodec,
        strictCodec: upsertMcpConnectorRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: upsertMcpConnectorResultCodec,
    },
    'agentEnhancer/setMcpConnectorEnabled': {
      service: 'agentEnhancer',
      implementation: 'setMcpConnectorEnabled',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: setMcpConnectorEnabledRequestCodec,
        strictCodec: setMcpConnectorEnabledRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: setMcpConnectorEnabledResultCodec,
    },
    'agentEnhancer/uninstallMcpConnector': {
      service: 'agentEnhancer',
      implementation: 'uninstallMcpConnector',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: uninstallMcpConnectorRequestCodec,
        strictCodec: uninstallMcpConnectorRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: uninstallMcpConnectorResultCodec,
    },
    'agentEnhancer/installMcpFromNpx': {
      service: 'agentEnhancer',
      implementation: 'installMcpFromNpx',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: installMcpFromNpxRequestCodec,
        strictCodec: installMcpFromNpxRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: installMcpFromNpxResultCodec,
    },
    'agentEnhancer/installMcpFromGit': {
      service: 'agentEnhancer',
      implementation: 'installMcpFromGit',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: installMcpFromGitRequestCodec,
        strictCodec: installMcpFromGitRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: installMcpFromGitResultCodec,
    },
    'agentEnhancer/importMcpJson': {
      service: 'agentEnhancer',
      implementation: 'importMcpJson',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: importMcpJsonRequestCodec,
        strictCodec: importMcpJsonRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: importMcpJsonResultCodec,
    },
    'agentEnhancer/listMcpConnectorTools': {
      service: 'agentEnhancer',
      implementation: 'listMcpConnectorTools',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: listMcpConnectorToolsRequestCodec,
        strictCodec: listMcpConnectorToolsRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: listMcpConnectorToolsResultCodec,
    },
  },
}, z)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'agent-enhancer/forbidden': {}
    'agent-enhancer/failed': { code: AuxiliaryErrorCode }
  }
}

const checkpointScopeSchema = z.enum(['conversation', 'conversation-and-files'])
export const checkpointRollbackRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  turn: z.number().int().positive(),
  operation: z.enum(['rollback', 'undo']).optional(),
  scope: checkpointScopeSchema.optional(),
  // Timeline cards pin the tip by atSeq (turn numbers reuse after undo).
  atSeq: z.number().int().nonnegative().optional(),
})
const checkpointMessageSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  type: z.string(),
  text: z.string(),
})
const checkpointFileSchema = z.strictObject({
  path: z.string(),
  change: z.enum(['create', 'modify', 'delete']),
})
const checkpointConflictSchema = z.strictObject({
  path: z.string(),
  reason: z.enum([
    'unsafe-path',
    'symlink',
    'not-regular-file',
    'binary',
    'too-large',
    'invalid-before-image',
    'invalid-after-image',
    'hash-mismatch',
  ]),
  expectedHash: z.string().optional(),
  actualHash: z.string().nullable().optional(),
})
const checkpointUnavailableSchema = z.enum([
  'checkpoint-not-found',
  'incomplete-checkpoint',
  'prompt-non-text-content',
  'workspace-capture-failed',
  'session-changed',
  'session-running',
  'permission-denied',
  'rollback-disabled',
  'incompatible-session',
  'compacted-surface',
  'subagent-session',
  'unknown-surface',
  'already-restored',
  'covered-by-earlier-restore',
])
const checkpointPreviewSchema = z.strictObject({
  sessionId: sessionIdSchema,
  turn: z.number().int().positive(),
  operation: z.enum(['rollback', 'undo']).optional(),
  scope: checkpointScopeSchema.optional(),
  tipTurn: z.number().int().positive().optional(),
  atSeq: z.number().int().nonnegative().optional(),
  messages: z.array(checkpointMessageSchema),
  files: z.array(checkpointFileSchema),
  conflicts: z.array(checkpointConflictSchema),
  unavailable: z.array(checkpointUnavailableSchema),
})
const checkpointResultSchema = z.strictObject({
  sessionId: sessionIdSchema,
  turn: z.number().int().positive(),
  draft: z.string(),
})
export const checkpointSummariesRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
const checkpointGapSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), reason: z.literal('non-text-content') }).strict(),
  z.object({ type: z.literal('workspace'), reason: z.literal('capture-failed') }).strict(),
])
const checkpointTurnSummarySchema = z.strictObject({
  turn: z.number().int().positive(),
  coverage: z.enum(['complete', 'partial']),
  fileCount: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  atSeq: z.number().int().nonnegative(),
  prompt: z.string(),
  promptPreview: z.string(),
  files: z.array(checkpointFileSchema),
  gaps: z.array(checkpointGapSchema),
  rolledBack: z.boolean(),
  tip: z.boolean(),
})
const liveActivityStatsSchema = z.strictObject({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  checkpoints: z.number().int().nonnegative(),
  liveCheckpoints: z.number().int().nonnegative(),
})
const checkpointSummariesResultSchema = z.strictObject({
  sessionId: sessionIdSchema,
  activity: liveActivityStatsSchema,
  turns: z.array(checkpointTurnSummarySchema),
})
export const checkpointCutRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
})
const checkpointCutViewSchema = z.strictObject({
  hideTurnsFrom: z.number().int().positive(),
  cutSeq: z.number().int().nonnegative(),
  restoredAtSeq: z.number().int().nonnegative(),
  draftPrompt: z.string(),
  scope: checkpointScopeSchema,
})
const checkpointCutResultSchema = z.strictObject({
  sessionId: sessionIdSchema,
  cut: checkpointCutViewSchema.nullable(),
})
const checkpointRequestCodec = codec('dsh-agent-enhancer#CheckpointRollbackRequest', checkpointRollbackRequestSchema)
const checkpointPreviewCodec = codec('dsh-agent-enhancer#CheckpointRollbackPreview', checkpointPreviewSchema)
const checkpointResultCodec = codec('dsh-agent-enhancer#CheckpointRollbackResult', checkpointResultSchema)
const checkpointSummariesRequestCodec = codec(
  'dsh-agent-enhancer#CheckpointSummariesRequest',
  checkpointSummariesRequestSchema,
)
const checkpointSummariesResultCodec = codec(
  'dsh-agent-enhancer#CheckpointSummariesResult',
  checkpointSummariesResultSchema,
)
const checkpointCutRequestCodec = codec(
  'dsh-agent-enhancer#CheckpointCutRequest',
  checkpointCutRequestSchema,
)
const checkpointCutResultCodec = codec(
  'dsh-agent-enhancer#CheckpointCutResult',
  checkpointCutResultSchema,
)

export const checkpointRemoteInfo = createTypertRemoteInfo({
  package: 'dsh-agent-enhancer',
  methods: {
    'checkpointRollback/preview': {
      service: 'checkpointRollback',
      implementation: 'preview',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', source: 'json', codec: checkpointRequestCodec, strictCodec: checkpointRequestCodec }],
      cancellation: { parameter: 'signal' },
      result: checkpointPreviewCodec,
    },
    'checkpointRollback/execute': {
      service: 'checkpointRollback',
      implementation: 'execute',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', source: 'json', codec: checkpointRequestCodec, strictCodec: checkpointRequestCodec }],
      cancellation: { parameter: 'signal' },
      result: checkpointResultCodec,
    },
    'checkpointRollback/summaries': {
      service: 'checkpointRollback',
      implementation: 'summaries',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: checkpointSummariesRequestCodec,
        strictCodec: checkpointSummariesRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: checkpointSummariesResultCodec,
    },
    'checkpointRollback/getCut': {
      service: 'checkpointRollback',
      implementation: 'getCut',
      invocation: { kind: 'direct' },
      parameters: [{
        name: 'request',
        source: 'json',
        codec: checkpointCutRequestCodec,
        strictCodec: checkpointCutRequestCodec,
      }],
      cancellation: { parameter: 'signal' },
      result: checkpointCutResultCodec,
    },
  },
}, z)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'agent-enhancer/rollback-failed': { code: CheckpointRollbackErrorCode }
  }
}
