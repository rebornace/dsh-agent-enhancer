import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
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
import type { CheckpointRollbackRequest } from './checkpoint/service.ts'
import { CheckpointStore } from './checkpoint/store.ts'
import { AuxiliaryModels } from './model.ts'
import { checkpointRemoteInfo, remoteInfo } from './rpc.ts'
import type { RpcPayload } from './rpc.ts'
import type { AuxiliaryResult } from './types.ts'

export const name = PLUGIN_ID
export const inject = ['llm', 'sessions', 'agents', 'sessionProjections', 'agentDefaultModel', 'fs', 'tools', 'typert', 'typertGateway']

export const Config = z.object({
  historyEnabled: z.boolean().default(true).volatile(),
  optimizeEnabled: z.boolean().default(true).volatile(),
  predictEnabled: z.boolean().default(true).volatile(),
  rollbackEnabled: z.boolean().default(true).volatile(),
  // Empty provider/model = follow the current Desktop session model.
  optimizeProvider: z.string().default('').volatile(),
  optimizeModel: z.string().default('').volatile(),
  optimizeReasoningEffort: z.string().default('').volatile(),
  predictProvider: z.string().default('').volatile(),
  predictModel: z.string().default('').volatile(),
  predictReasoningEffort: z.string().default('').volatile(),
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
  constructor(ctx: Context, private readonly models: AuxiliaryModels) {
    super(ctx, 'agentEnhancer')
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
  }
}

export function apply(ctx: Context, config: Config): void {
  const models = new AuxiliaryModels(ctx, () => ({
    optimizeProvider: config.optimizeProvider.get(),
    optimizeModel: config.optimizeModel.get(),
    optimizeReasoningEffort: config.optimizeReasoningEffort.get(),
    predictProvider: config.predictProvider.get(),
    predictModel: config.predictModel.get(),
    predictReasoningEffort: config.predictReasoningEffort.get(),
  }))
  new AgentEnhancerService(ctx, models)
  ctx.effect(() => ctx.typert.register(hostContribution))

  const storageRoot = resolveCheckpointRoot(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const store = new CheckpointStore(storageRoot)
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
  })
  applyCheckpointRollback(ctx, rollback)
  void rollback.recover().catch(() => {
    ctx.logger.warn('Checkpoint rollback recovery is still pending')
  })

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
