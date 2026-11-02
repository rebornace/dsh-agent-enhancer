import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { AuxiliaryError } from '../errors.ts'
import { DshCheckpointSessions } from './checkpoint/dsh.ts'
import { DshCheckpointCaptureSwitch } from './checkpoint/live.ts'
import { CheckpointRollbackError, CheckpointRollbackService } from './checkpoint/service.ts'
import type { CheckpointRollbackRequest } from './checkpoint/service.ts'
import { CheckpointStore } from './checkpoint/store.ts'
import { AuxiliaryModels } from './model.ts'
import { checkpointRemoteInfo, remoteInfo } from './rpc.ts'
import type { RpcPayload } from './rpc.ts'
import type { AuxiliaryResult } from './types.ts'

export const name = 'composer-enhancer'
export const inject = ['llm', 'sessions', 'agents', 'sessionProjections', 'agentDefaultModel', 'fs', 'tools', 'typert', 'typertGateway']

export const Config = z.object({
  historyEnabled: z.boolean().default(true).volatile(),
  optimizeEnabled: z.boolean().default(true).volatile(),
  predictEnabled: z.boolean().default(true).volatile(),
  rollbackEnabled: z.boolean().default(false).volatile(),
})
export type Config = ReturnType<typeof Config>

/** Single Host package-face contribution. Typert rejects a second register for the same package#face. */
export const hostContribution = {
  package: 'dsh-composer-enhancer',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [...remoteInfo.descriptors, ...checkpointRemoteInfo.descriptors],
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

export function apply(ctx: Context, config: Config): void {
  const models = new AuxiliaryModels(ctx)
  new ComposerEnhancerService(ctx, models)
  ctx.effect(() => ctx.typert.register(hostContribution))

  const storageRoot = join(
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'profiles', 'desktop', 'plugin-data', 'dsh-composer-enhancer', 'checkpoint',
  )
  const store = new CheckpointStore(storageRoot)
  const sessions = new DshCheckpointSessions(ctx)
  let rollbackEnabled = config.rollbackEnabled.get()
  const rollback = new CheckpointRollbackService({
    store,
    storageRoot,
    pluginVersion: '0.1.5',
    resolveSession: sessions.resolveSession,
    isEnabled: () => rollbackEnabled,
  })
  applyCheckpointRollback(ctx, rollback)
  void rollback.recover().catch(() => {
    ctx.logger.warn('Checkpoint rollback recovery is still pending')
  })

  const captures = new DshCheckpointCaptureSwitch(ctx, { store, pluginVersion: '0.1.5' })
  ctx.effect(() => {
    const unsubscribe = ctx.on('internal/update', (updated, _noSave, next) => {
      rollbackEnabled = (updated as Config).rollbackEnabled.get()
      captures.setEnabled(rollbackEnabled)
      next()
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
  package: 'dsh-composer-enhancer',
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

  private assertOwner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('composer-enhancer/forbidden', 'Only the desktop owner may use checkpoint rollback', {})
    }
  }

  private remoteError(error: unknown, signal: AbortSignal): unknown {
    if (signal.aborted) return error
    const code = error instanceof CheckpointRollbackError ? error.code : 'ROLLBACK_FAILED'
    return new RemoteError('composer-enhancer/rollback-failed', 'Checkpoint rollback request failed', { code })
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
