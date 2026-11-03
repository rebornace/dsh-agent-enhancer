import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-projection'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEFAULT_AUXILIARY_MODEL,
  DEFAULT_SETTINGS,
  auxiliaryModelOf,
  autoRouteMapOf,
  isAutoModel,
  isFollowSessionModel,
} from '../config.ts'
import type { AuxiliaryFeature, AuxiliaryModelSettings, EnhancerSettings } from '../config.ts'
import { createClassifier } from './auto-route/classifier.ts'
import { getSessionResolvedRouteForSession } from './auto-route/session-resolved-route.ts'
import { projectedSessionModel } from './auto-route/session-selection.ts'
import { resolveAutoRoute } from './auto-route/router.ts'
import type { AutoTierRoute } from './auto-route/types.ts'
import { AuxiliaryError } from '../errors.ts'
import {
  auxiliaryUserInput,
  optimizeSystemPrompt,
  predictSystemPrompt,
  resolveUiLocale,
} from './prompts.ts'
import { maskReferences, unmaskReferences } from './structured.ts'
import type { AuxiliaryRequest, AuxiliaryResult, ModelRoute } from './types.ts'

export type AuxiliarySettingsReader = () => Pick<EnhancerSettings,
  | 'optimizeProvider' | 'optimizeModel' | 'optimizeReasoningEffort'
  | 'predictProvider' | 'predictModel' | 'predictReasoningEffort'
  | 'autoClassifierEnabled'
  | 'autoInstantProvider' | 'autoInstantModel' | 'autoInstantReasoningEffort'
  | 'autoThinkingProvider' | 'autoThinkingModel' | 'autoThinkingReasoningEffort'
  | 'autoProProvider' | 'autoProModel' | 'autoProReasoningEffort'
  | 'autoClassifierProvider' | 'autoClassifierModel' | 'autoClassifierReasoningEffort'
>

interface ResolvedRoute extends ModelRoute {
  readonly preferredEffort: string
}

function outputText(assembler: BlockAssembler): string {
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
    throw new AuxiliaryError('INVALID_OUTPUT')
  }
  let text = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  const paired = /^(`{1,3})([\s\S]*?)\1$/.exec(text)
  if (paired !== null) text = paired[2]!.trim()
  if (text === '') throw new AuxiliaryError('INVALID_OUTPUT')
  return text
}

function pickReasoningEffort(
  info: Readonly<LlmResolvedModelInfo>,
  preferred: string,
): ReasoningEffortId | undefined {
  const efforts = info.reasoning?.efforts ?? []
  if (preferred !== '' && efforts.some(effort => effort.id === preferred)) {
    return ReasoningEffortId(preferred)
  }
  if (info.reasoning?.defaultEffort !== undefined) return info.reasoning.defaultEffort
  return efforts[0]?.id
}

export class AuxiliaryModels {
  private readonly lifetime = new AbortController()
  private readonly requests = new Map<SessionId, Set<AbortController>>()
  private readonly predictedTurns = new Set<string>()
  private readonly pending = new Set<Promise<AuxiliaryResult | null>>()
  private readonly settings: AuxiliarySettingsReader

  constructor(private readonly ctx: Context, settings?: AuxiliarySettingsReader) {
    this.settings = settings ?? (() => ({
      optimizeProvider: DEFAULT_AUXILIARY_MODEL.provider,
      optimizeModel: DEFAULT_AUXILIARY_MODEL.model,
      optimizeReasoningEffort: DEFAULT_AUXILIARY_MODEL.reasoningEffort,
      predictProvider: DEFAULT_AUXILIARY_MODEL.provider,
      predictModel: DEFAULT_AUXILIARY_MODEL.model,
      predictReasoningEffort: DEFAULT_AUXILIARY_MODEL.reasoningEffort,
      autoClassifierEnabled: DEFAULT_SETTINGS.autoClassifierEnabled,
      autoInstantProvider: DEFAULT_SETTINGS.autoInstantProvider,
      autoInstantModel: DEFAULT_SETTINGS.autoInstantModel,
      autoInstantReasoningEffort: DEFAULT_SETTINGS.autoInstantReasoningEffort,
      autoThinkingProvider: DEFAULT_SETTINGS.autoThinkingProvider,
      autoThinkingModel: DEFAULT_SETTINGS.autoThinkingModel,
      autoThinkingReasoningEffort: DEFAULT_SETTINGS.autoThinkingReasoningEffort,
      autoProProvider: DEFAULT_SETTINGS.autoProProvider,
      autoProModel: DEFAULT_SETTINGS.autoProModel,
      autoProReasoningEffort: DEFAULT_SETTINGS.autoProReasoningEffort,
      autoClassifierProvider: DEFAULT_SETTINGS.autoClassifierProvider,
      autoClassifierModel: DEFAULT_SETTINGS.autoClassifierModel,
      autoClassifierReasoningEffort: DEFAULT_SETTINGS.autoClassifierReasoningEffort,
    }))
    ctx.on('session/disposed', (session) => { this.cancelSession(session.id) })
    ctx.effect(() => async () => {
      this.lifetime.abort()
      this.predictedTurns.clear()
      await Promise.allSettled([...this.pending])
    })
  }

  generate(request: AuxiliaryRequest, signal: AbortSignal): Promise<AuxiliaryResult | null> {
    const pending = this.execute(request, signal)
    this.pending.add(pending)
    return pending.finally(() => { this.pending.delete(pending) })
  }

  private cancelSession(sessionId: SessionId): void {
    const requests = this.requests.get(sessionId)
    if (requests !== undefined) {
      for (const controller of requests) controller.abort()
      this.requests.delete(sessionId)
    }
    const prefix = `${sessionId}:`
    for (const key of this.predictedTurns) {
      if (key.startsWith(prefix)) this.predictedTurns.delete(key)
    }
  }

  private currentSession(sessionId: SessionId): Session {
    const sessions = this.ctx.get('sessions') as unknown as SessionStore
    const session = sessions.get(sessionId)
    if (session === undefined) throw new AuxiliaryError('SESSION_CHANGED')
    return session
  }

  private assertCurrent(session: Session): void {
    const sessions = this.ctx.get('sessions') as unknown as SessionStore
    if (sessions.get(session.id) !== session) throw new AuxiliaryError('SESSION_CHANGED')
  }

  private enhancerSettings(): EnhancerSettings {
    return this.settings() as EnhancerSettings
  }

  private featureSettings(feature: AuxiliaryFeature): AuxiliaryModelSettings {
    return auxiliaryModelOf(this.enhancerSettings(), feature)
  }

  private modelExists(provider: string, model: string): boolean {
    return provider !== '' && model !== ''
  }

  private sessionModelSelection(session: Session): {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  } {
    return projectedSessionModel(this.ctx, session)
  }

  private resolvedRouteFromSession(session: Session, effortFallback: string): ResolvedRoute | undefined {
    const cached = getSessionResolvedRouteForSession(session)
    if (cached === undefined) return undefined
    return {
      provider: cached.provider,
      model: cached.model,
      preferredEffort: cached.reasoningEffort !== '' ? cached.reasoningEffort : effortFallback,
    }
  }

  private tierRouteFromSelection(
    selection: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string },
    effortFallback: string,
  ): AutoTierRoute {
    return {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: typeof selection.reasoningEffort === 'string'
        ? selection.reasoningEffort
        : effortFallback,
    }
  }

  private fallbackFromSession(session: Session, override: AuxiliaryModelSettings): AutoTierRoute | undefined {
    const selection = this.sessionModelSelection(session)
    if (!isAutoModel(selection) && this.modelExists(selection.provider, selection.model)) {
      return this.tierRouteFromSelection(selection, override.reasoningEffort)
    }
    const fallback = this.ctx.agentDefaultModel.currentSelection()
    if (isAutoModel(fallback) || !this.modelExists(fallback.provider, fallback.model)) return undefined
    return this.tierRouteFromSelection(fallback, override.reasoningEffort)
  }

  private async resolveAutoRouteFor(
    session: Session,
    override: AuxiliaryModelSettings,
    text: string,
    feature: AuxiliaryFeature | 'session',
  ): Promise<ResolvedRoute> {
    const settings = this.enhancerSettings()
    const map = autoRouteMapOf(settings)
    const classify = settings.autoClassifierEnabled
      ? createClassifier(this.ctx.llm, map.classifier)
      : undefined
    const mapped = await resolveAutoRoute({
      text,
      feature,
      map,
      classifierEnabled: settings.autoClassifierEnabled,
      classify,
      isAvailable: (provider, model) => this.modelExists(provider, model),
      fallback: this.fallbackFromSession(session, override),
    })
    return {
      provider: mapped.provider,
      model: mapped.model,
      preferredEffort: mapped.reasoningEffort,
    }
  }

  private async route(session: Session, feature: AuxiliaryFeature, text: string): Promise<ResolvedRoute> {
    const override = this.featureSettings(feature)
    if (isAutoModel(override)) {
      return this.resolveAutoRouteFor(session, override, text, feature)
    }
    if (!isFollowSessionModel(override)) {
      return {
        provider: override.provider,
        model: override.model,
        preferredEffort: override.reasoningEffort,
      }
    }
    const selection = this.sessionModelSelection(session)
    if (selection.provider === '' || selection.model === '') throw new AuxiliaryError('MODEL_UNAVAILABLE')
    if (isAutoModel(selection)) {
      const cached = this.resolvedRouteFromSession(session, override.reasoningEffort)
      if (cached !== undefined) return cached
      return this.resolveAutoRouteFor(session, override, text, 'session')
    }
    const preferredEffort = typeof selection.reasoningEffort === 'string'
      ? selection.reasoningEffort
      : override.reasoningEffort
    return {
      provider: selection.provider,
      model: selection.model,
      preferredEffort,
    }
  }

  private async execute(request: AuxiliaryRequest, signal: AbortSignal): Promise<AuxiliaryResult | null> {
    const controller = new AbortController()
    const abort = () => { controller.abort(signal.reason) }
    const hostAbort = () => { controller.abort(this.lifetime.signal.reason) }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    if (this.lifetime.signal.aborted) hostAbort()
    else this.lifetime.signal.addEventListener('abort', hostAbort, { once: true })
    let sessionRequests: Set<AbortController> | undefined
    try {
      controller.signal.throwIfAborted()
      if (request.operation === 'predict') {
        const latest = request.context[request.context.length - 1]
        if (latest === undefined) return null
        const key = `${request.sessionId}:${latest.turn}`
        if (this.predictedTurns.has(key)) return null
        this.predictedTurns.add(key)
      }
      const session = this.currentSession(request.sessionId)
      sessionRequests = this.requests.get(session.id) ?? new Set<AbortController>()
      sessionRequests.add(controller)
      this.requests.set(session.id, sessionRequests)
      const operation = request.operation
      const routeText = operation === 'optimize' ? request.source : ''
      const resolved = await this.route(session, operation, routeText)
      const route: ModelRoute = { provider: resolved.provider, model: resolved.model }
      const masked = operation === 'optimize' ? maskReferences(request.source, request.references) : undefined
      const maxTokens = operation === 'optimize' ? 1200 : 120
      const uiLocale = resolveUiLocale(request.uiLocale)
      const system = operation === 'optimize'
        ? optimizeSystemPrompt(uiLocale)
        : predictSystemPrompt(uiLocale)
      const call = await this.ctx.llm.prepareCall({ ...route, maxTokens }, controller.signal, (controls, info) => {
        const reasoningEffort = pickReasoningEffort(info, resolved.preferredEffort)
        return reasoningEffort === undefined ? controls : { ...controls, reasoningEffort }
      })
      controller.signal.throwIfAborted()
      this.assertCurrent(session)
      const options: GenerateOptions = {
        ...call.config,
        system,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: auxiliaryUserInput(request, uiLocale, masked?.source) }],
        }],
        tools: [],
        sessionId: session.id,
        signal: controller.signal,
      }
      appendPluginRecord(session, 'plugin:agent-enhancer/request', {
        operation,
        requestId: request.requestId,
        route,
        system,
        messages: options.messages,
        maxTokens,
      })
      controller.signal.throwIfAborted()
      const assembler = new BlockAssembler()
      for await (const chunk of call.stream(options)) {
        controller.signal.throwIfAborted()
        this.assertCurrent(session)
        if (chunk.type === 'tool-call-delta') throw new AuxiliaryError('INVALID_OUTPUT')
        assembler.push(chunk)
      }
      controller.signal.throwIfAborted()
      this.assertCurrent(session)
      if (assembler.finish.kind !== 'stop') throw new AuxiliaryError('INVALID_OUTPUT')
      const text = outputText(assembler)
      if (masked === undefined || request.operation === 'predict') {
        return { requestId: request.requestId, text, route }
      }
      const restored = unmaskReferences(text, masked.placeholders, request.references)
      return {
        requestId: request.requestId,
        text: restored.text,
        ...(request.references.length === 0 ? {} : { segments: restored.segments }),
        route,
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      if (error instanceof AuxiliaryError) throw error
      throw new AuxiliaryError('MODEL_FAILED')
    } finally {
      signal.removeEventListener('abort', abort)
      this.lifetime.signal.removeEventListener('abort', hostAbort)
      sessionRequests?.delete(controller)
      if (sessionRequests?.size === 0 && this.requests.get(request.sessionId) === sessionRequests) {
        this.requests.delete(request.sessionId)
      }
    }
  }
}
