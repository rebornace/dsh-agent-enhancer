import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { AuxiliaryError } from '../errors.ts'
import { AuxiliaryModels } from './model.ts'
import { remoteInfo } from './rpc.ts'
import type { RpcPayload } from './rpc.ts'
import type { AuxiliaryResult } from './types.ts'

export const name = 'composer-enhancer'
export const inject = ['llm', 'sessions', 'sessionProjections', 'agentDefaultModel', 'typert', 'typertGateway']

export const Config = z.object({
  historyEnabled: z.boolean().default(true).volatile(),
  optimizeEnabled: z.boolean().default(true).volatile(),
  predictEnabled: z.boolean().default(true).volatile(),
})
export type Config = ReturnType<typeof Config>

export const hostContribution = {
  package: 'dsh-composer-enhancer',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: remoteInfo.descriptors,
} as const

export class ComposerEnhancerService extends TypertRemoteService {
  constructor(ctx: Context, private readonly models: AuxiliaryModels) {
    super(ctx, 'composerEnhancer')
  }

  async call(payload: RpcPayload, signal: AbortSignal): Promise<AuxiliaryResult | null> {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('composer-enhancer/forbidden', 'Only the desktop owner may use Composer Enhance', {})
    }
    try {
      return await this.models.generate(payload.data, signal)
    } catch (error) {
      if (signal.aborted) throw error
      const code = error instanceof AuxiliaryError ? error.code : 'MODEL_FAILED'
      throw new RemoteError('composer-enhancer/failed', 'Composer Enhance request failed', { code })
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    composerEnhancer: ComposerEnhancerService
  }
}

export function apply(ctx: Context, _config: Config): void {
  const models = new AuxiliaryModels(ctx)
  new ComposerEnhancerService(ctx, models)
  ctx.effect(() => ctx.typert.register(hostContribution))
}
