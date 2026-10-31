import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import type { TypertRemoteCodecSpec } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'
import type { AuxiliaryErrorCode } from '../errors.ts'

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
