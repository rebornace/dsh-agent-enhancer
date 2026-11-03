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
  auxiliaryModelOf,
  isFollowSessionModel,
} from '../config.ts'
import type { AuxiliaryFeature, AuxiliaryModelSettings, EnhancerSettings } from '../config.ts'
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

  private featureSettings(feature: AuxiliaryFeature): AuxiliaryModelSettings {
    return auxiliaryModelOf(this.settings() as EnhancerSettings, feature)
  }

  private route(session: Session, feature: AuxiliaryFeature): ResolvedRoute {
    const override = this.featureSettings(feature)
    if (!isFollowSessionModel(override)) {
      return {
        provider: override.provider,
        model: override.model,
        preferredEffort: override.reasoningEffort,
      }
    }
    const logged = session.requestHeader()?.config
    const projected = logged === undefined
      ? this.ctx.sessionProjections.stateOf(session, 'modelSelection')
      : undefined
    const selection = logged ?? projected?.pending ?? projected?.lastUsed
      ?? this.ctx.agentDefaultModel.currentSelection()
    if (selection.provider === '' || selection.model === '') throw new AuxiliaryError('MODEL_UNAVAILABLE')
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
      const resolved = this.route(session, request.operation)
      const route: ModelRoute = { provider: resolved.provider, model: resolved.model }
      const operation = request.operation
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
