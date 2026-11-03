import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { AuxiliaryErrorCode } from '../errors.ts'
import type { CheckpointRollbackErrorCode } from './checkpoint/service.ts'

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
  message: z.string(),
  command: z.string().optional(),
})
const updateCheckResultCodec = codec('dsh-agent-enhancer#UpdateCheckResult', updateCheckResultSchema)
const applyUpdateResultCodec = codec('dsh-agent-enhancer#ApplyUpdateResult', applyUpdateResultSchema)

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
  'first-turn',
  'incompatible-session',
  'compacted-surface',
  'subagent-session',
  'unknown-surface',
])
const checkpointPreviewSchema = z.strictObject({
  sessionId: sessionIdSchema,
  turn: z.number().int().positive(),
  operation: z.enum(['rollback', 'undo']).optional(),
  scope: checkpointScopeSchema.optional(),
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
const checkpointRequestCodec = codec('dsh-agent-enhancer#CheckpointRollbackRequest', checkpointRollbackRequestSchema)
const checkpointPreviewCodec = codec('dsh-agent-enhancer#CheckpointRollbackPreview', checkpointPreviewSchema)
const checkpointResultCodec = codec('dsh-agent-enhancer#CheckpointRollbackResult', checkpointResultSchema)

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
  },
}, z)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'agent-enhancer/rollback-failed': { code: CheckpointRollbackErrorCode }
  }
}
