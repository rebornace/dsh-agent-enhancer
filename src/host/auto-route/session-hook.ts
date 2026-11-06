import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import { autoRouteMapOf, isAutoModel } from '../../config.ts'
import type { EnhancerSettings } from '../../config.ts'
import { createClassifier } from './classifier.ts'
import { resolveAutoRoute } from './router.ts'
import {
  clearSessionResolvedRoute,
  setSessionResolvedRoute,
} from './session-resolved-route.ts'
import { projectedSessionModel } from './session-selection.ts'
import { sessionTurnHint } from './session-turn-hint.ts'
import { AUTO_MODEL, AUTO_PROVIDER } from './sentinel.ts'
import type { AutoTierRoute } from './types.ts'

/**
 * Path 1 — official `/model` and the composer model seat.
 *
 * Catalog sentinel `{ provider: AUTO_PROVIDER, model: AUTO_MODEL }` is what
 * `agent.model.select` / official `selectModel` persist. DSH 0.2.2 freezes that
 * seat for the step before prompt assembly (do not mutate `agent/request` for
 * routing; do not `agent.model.select` the mapped Instant/Thinking/Pro tier or
 * the picker leaves Auto).
 *
 * Each step still calls `llm.prepareCall` with the frozen Auto seat. The
 * wrapper below remaps only that sentinel onto the configured tier for the
 * provider stream — once per call, including tool retries — then returns the
 * real adapter binding. Session seat and `agent.model.current()` stay Auto.
 */
const AUTO_CATALOG_NAME = 'Auto'
/**
 * Compaction (compaction-basic) rejects `selectModel` when the target route has
 * no positive `context.contextWindow`. Auto never streams, but switching onto
 * the sentinel still runs that preflight — advertise a generous capacity so
 * the picker can land on Auto; `prepareCall` remaps to a concrete tier before
 * the provider call, where the real model's window applies.
 */
const AUTO_CONTEXT_WINDOW = 524_288

interface TurnNote {
  readonly text: string
  readonly toolHeavy: boolean
}

interface ModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

interface AgentFace {
  readonly options?: { readonly provider?: string, readonly model?: string }
  readonly status?: string
  readonly session?: object
  readonly model?: {
    readonly current?: () => ModelPick | undefined
  }
}

interface ContentBlockLike {
  readonly type?: string
  readonly text?: string
}

interface MessageLike {
  readonly role?: string
  readonly content?: readonly ContentBlockLike[]
}

interface AgentsFace {
  currentInitiator?: () => object | undefined
  list?: () => readonly object[]
}

class AutoCatalogAdapter extends LlmAdapter {
  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: AUTO_CATALOG_NAME }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{
      provider,
      id: AUTO_MODEL,
      name: AUTO_CATALOG_NAME,
      inputModalities: ['text'],
    }])
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: AUTO_CATALOG_NAME,
      inputModalities: ['text'],
      context: { contextWindow: AUTO_CONTEXT_WINDOW },
    })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'Auto is a routing sentinel and is not sent to a provider',
      'AUTO_SENTINEL',
    )
  }
}

function describeTurn(messages: readonly MessageLike[], step: number): TurnNote {
  const parts: string[] = []
  let toolHeavy = step > 1
  for (const message of messages) {
    if (message.role === 'tool') toolHeavy = true
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call') toolHeavy = true
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        parts.push(block.text)
      }
    }
  }
  return { text: parts.join('\n'), toolHeavy }
}

function loggedTurn(agent: AgentFace | undefined): TurnNote | undefined {
  return sessionTurnHint(agent?.session)
}

/** Cordis throws when reading required injects on an inactive fiber — never hard-crash Auto. */
function softService<T>(ctx: Context, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

function agentsOf(ctx: Context): AgentsFace | undefined {
  return softService<AgentsFace>(ctx, 'agents')
}

function activeAgent(ctx: Context): object | undefined {
  try {
    const agents = agentsOf(ctx)
    if (agents === undefined) return undefined
    try {
      const current = agents.currentInitiator?.()
      if (current !== undefined) return current
    } catch {
      // A disposing initiator scope throws; fall through to the live roster.
    }
    const running = (agents.list?.() ?? []).filter(agent => (agent as AgentFace).status === 'running')
    return running.length === 1 ? running[0] : undefined
  } catch {
    return undefined
  }
}

function asAgent(agent: object | undefined): AgentFace | undefined {
  return agent as AgentFace | undefined
}

function concreteRoute(selection: ModelPick | undefined): AutoTierRoute | undefined {
  if (
    selection === undefined
    || selection.provider === ''
    || selection.model === ''
    || isAutoModel(selection)
  ) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : '',
  }
}

/** Live seat via `agent.model.current()`, then Session projection helpers. */
function projectedSelection(ctx: Context, agent: AgentFace | undefined): ModelPick | undefined {
  try {
    const fromModel = agent?.model?.current?.()
    if (fromModel !== undefined
      && typeof fromModel.provider === 'string'
      && fromModel.provider !== ''
      && typeof fromModel.model === 'string'
      && fromModel.model !== '') {
      return fromModel
    }
  } catch {
    // ignore
  }
  const session = agent?.session as { readonly id?: unknown } | undefined
  if (session === undefined) return undefined
  try {
    return projectedSessionModel(ctx, session as never)
  } catch {
    return undefined
  }
}

function fallbackRoute(ctx: Context, agent: AgentFace | undefined): AutoTierRoute | undefined {
  try {
    // Prefer a concrete seat from agent.model / options; skip Auto itself.
    const projected = concreteRoute(projectedSelection(ctx, agent))
    if (projected !== undefined) return projected
    const options = agent?.options
    const fromOptions = typeof options?.provider === 'string' && typeof options.model === 'string'
      ? concreteRoute({ provider: options.provider, model: options.model })
      : undefined
    if (fromOptions !== undefined) return fromOptions
    const defaults = softService<{ currentSelection?: () => ModelPick | undefined }>(ctx, 'agentDefaultModel')
    return concreteRoute(defaults?.currentSelection?.())
  } catch {
    return undefined
  }
}

/** True when the frozen call config or the live agent seat is the Auto sentinel. */
function shouldRemapAuto(config: LlmCallConfig, agent: AgentFace | undefined): boolean {
  if (isAutoModel(config)) return true
  try {
    const seat = agent?.model?.current?.()
    return seat !== undefined && isAutoModel(seat)
  } catch {
    return false
  }
}

function routeConfig(config: LlmCallConfig, mapped: AutoTierRoute): LlmCallConfig {
  const { reasoningEffort: _effort, ...rest } = config
  void _effort
  if (mapped.reasoningEffort === '') return { ...rest, provider: mapped.provider, model: mapped.model }
  return {
    ...rest,
    provider: mapped.provider,
    model: mapped.model,
    reasoningEffort: ReasoningEffortId(mapped.reasoningEffort),
  }
}

function installAutoCatalogModel(ctx: Context): void {
  const llm = ctx.llm
  if (typeof llm.registerAdapter !== 'function' || typeof llm.listProviders !== 'function') return
  if (llm.listProviders().some(provider => provider.id === AUTO_PROVIDER)) {
    ctx.logger.warn('agent-enhancer: Auto was not added to the model catalog because that provider id is already registered')
    return
  }
  ctx.effect(() => {
    let handle: (() => void) | undefined
    try {
      handle = llm.registerAdapter([AUTO_PROVIDER], new AutoCatalogAdapter())
    } catch (error) {
      ctx.logger.warn(`agent-enhancer: Auto was not added to the model catalog: ${String(error)}`)
      return () => {}
    }
    return () => { handle?.() }
  })
}

export function installAutoSessionRoute(
  ctx: Context,
  options: { readonly settings: () => EnhancerSettings },
): void {
  installAutoCatalogModel(ctx)
  if (typeof ctx.llm.prepareCall !== 'function') return

  // Loop freezes `agent.model` for the step, then calls `prepareCall` with that
  // seat. The admitted user batch is not in the session log yet, so the latest
  // `agent/pre-step` decision is the turn text. Nested `prepareCall`s (the
  // classifier) pass through via `resolving` depth.
  const notes = new WeakMap<object, TurnNote>()
  const resolving = new WeakMap<object, number>()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    switch (decision.kind) {
      case 'enter':
        clearSessionResolvedRoute(payload.agent)
        notes.set(payload.agent, describeTurn(decision.messages, payload.step))
        return decision
      case 'reject':
        return decision
      default: {
        const _exhaustive: never = decision
        return _exhaustive
      }
    }
  })

  ctx.effect(() => {
    const llm = ctx.llm
    if (typeof llm.prepareCall !== 'function') return () => {}
    const innerPrepare = llm.prepareCall.bind(llm)
    const innerStream = typeof llm.stream === 'function' ? llm.stream.bind(llm) : undefined

    const remapAuto = async (
      config: LlmCallConfig,
      signal: AbortSignal | undefined,
      agent: object | undefined,
      feature: 'session' | 'compact' = 'session',
    ): Promise<AutoTierRoute> => {
      const settings = options.settings()
      const map = autoRouteMapOf(settings)
      const note = (agent === undefined ? undefined : notes.get(agent)) ?? loggedTurn(asAgent(agent))
      const classify = settings.autoClassifierEnabled
        ? createClassifier({ prepareCall: innerPrepare }, map.classifier)
        : undefined
      const mapped = await resolveAutoRoute({
        text: note?.text ?? '',
        feature,
        toolHeavy: note?.toolHeavy ?? false,
        map,
        classifierEnabled: settings.autoClassifierEnabled,
        classify,
        isAvailable: (provider, model) => provider !== '' && model !== '' && !isAutoModel({ provider, model }),
        signal,
        fallback: fallbackRoute(ctx, asAgent(agent)),
      })
      if (agent !== undefined && feature === 'session') setSessionResolvedRoute(agent, mapped)
      return mapped
    }

    const wrappedPrepare: typeof llm.prepareCall = async (config, signal, configure) => {
      const agent = activeAgent(ctx)
      const keyProbe = agent ?? config
      const depth = resolving.get(keyProbe) ?? 0
      if (depth > 0 || !shouldRemapAuto(config, asAgent(agent))) {
        return innerPrepare(config, signal, configure)
      }
      const key = agent ?? config
      resolving.set(key, (resolving.get(key) ?? 0) + 1)
      try {
        const mapped = await remapAuto(config, signal, agent)
        // Remap call config only — never agent.model.select(mapped).
        return await innerPrepare(routeConfig(config, mapped), signal, configure)
      } finally {
        const nextDepth = (resolving.get(key) ?? 1) - 1
        if (nextDepth <= 0) resolving.delete(key)
        else resolving.set(key, nextDepth)
      }
    }

    llm.prepareCall = wrappedPrepare

    // Compaction-basic (and other helpers) call llm.stream() with the frozen
    // Auto seat from requestHeader — that path never hits prepareCall, so the
    // sentinel would throw AUTO_SENTINEL. Remap the same way before dispatch.
    let wrappedStream: typeof llm.stream | undefined
    if (innerStream !== undefined) {
      wrappedStream = (options) => {
        // compaction-basic streams with requestHeader / agent.options. Auto seats
        // never hit prepareCall — remap the sentinel here too (including
        // purpose=compaction). Do not force a plugin compact model on top.
        const agent = activeAgent(ctx)
        if (!shouldRemapAuto(options, asAgent(agent))) return innerStream(options)
        const keyProbe = agent ?? options
        const depth = resolving.get(keyProbe) ?? 0
        if (depth > 0) return innerStream(options)
        return (async function* remappedAutoStream() {
          const key = agent ?? options
          resolving.set(key, (resolving.get(key) ?? 0) + 1)
          try {
            const mapped = await remapAuto(options, options.signal, agent, 'session')
            const routed = routeConfig(options, mapped)
            yield* innerStream({ ...options, ...routed })
          } finally {
            const nextDepth = (resolving.get(key) ?? 1) - 1
            if (nextDepth <= 0) resolving.delete(key)
            else resolving.set(key, nextDepth)
          }
        })()
      }
      llm.stream = wrappedStream
    }

    return () => {
      if (llm.prepareCall === wrappedPrepare) llm.prepareCall = innerPrepare
      if (wrappedStream !== undefined && llm.stream === wrappedStream && innerStream !== undefined) {
        llm.stream = innerStream
      }
    }
  })
}
