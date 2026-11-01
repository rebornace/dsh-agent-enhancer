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
const optimizeRequestSchema = z.strictObject({
  operation: z.literal('optimize'),
  requestId: z.string(),
  sessionId: sessionIdSchema,
  source: z.string(),
  references: z.array(optimizeReferenceSchema),
  context: z.array(recentExchangeSchema),
})
const predictRequestSchema = z.strictObject({
  operation: z.literal('predict'),
  requestId: z.string(),
  sessionId: sessionIdSchema,
  context: z.array(recentExchangeSchema),
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

const payloadCodec = codec('dsh-composer-enhancer#RpcPayload', rpcPayloadSchema)
const resultCodec = codec(
  'dsh-composer-enhancer#AuxiliaryResult|null',
  z.union([auxiliaryResultSchema, z.null()]),
)

export const remoteInfo = createTypertRemoteInfo({
  package: 'dsh-composer-enhancer',
  methods: {
    'composerEnhancer/call': {
      service: 'composerEnhancer',
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
  },
}, z)

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'composer-enhancer/forbidden': {}
    'composer-enhancer/failed': { code: AuxiliaryErrorCode }
  }
}

export const checkpointRollbackRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  turn: z.number().int().positive(),
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
const checkpointRequestCodec = codec('dsh-composer-enhancer#CheckpointRollbackRequest', checkpointRollbackRequestSchema)
const checkpointPreviewCodec = codec('dsh-composer-enhancer#CheckpointRollbackPreview', checkpointPreviewSchema)
const checkpointResultCodec = codec('dsh-composer-enhancer#CheckpointRollbackResult', checkpointResultSchema)

export const checkpointRemoteInfo = createTypertRemoteInfo({
  package: 'dsh-composer-enhancer',
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
    'composer-enhancer/rollback-failed': { code: CheckpointRollbackErrorCode }
  }
}
