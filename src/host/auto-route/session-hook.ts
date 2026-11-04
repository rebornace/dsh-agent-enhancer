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
 * Both entries load `session.modelCatalog`, which is `buildModelCatalog` over
 * the live `ctx.llm` registry. That is a different function from
 * `buildAuxiliaryModelCatalog`; this plugin does not own the official builder.
 * `session.selectModel` persists a choice only after `modelAvailable` and
 * `resolveCallConfig` accept the provider/model pair. The
 * `conversation.input.model.label` slot is non-interactive, so a label cannot
 * become a saved selection. Prepending a row only in our settings catalog
 * would show Auto and then fail when the official selector calls `select`.
 *
 * Registering a catalog-only adapter for the Auto sentinel puts
 * `{ provider: AUTO_PROVIDER, model: AUTO_MODEL }` in the official directory.
 * `selectModel` appends `model/selection` with that sentinel and
 * `agent/request` copies it onto the next call config. The `prepareCall`
 * wrapper below reroutes only that sentinel, once per call, and does not
 * write the resolved tier back onto the session.
 *
 * DSH 0.2.2 freezes the step model before prompt assembly / pre-step and asks
 * plugins to prefer `agent.model` over mutating `agent/request`. Remapping the
 * Auto sentinel inside `prepareCall` still runs before the provider stream and
 * keeps the session seat on the sentinel (so the picker stays on Auto).
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

interface AgentFace {
  readonly options?: { readonly provider?: string, readonly model?: string }
  readonly status?: string
  readonly session?: object
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

interface ModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
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

/** Saved session choice: pending user selection, otherwise the last request that consumed one. */
function projectedSelection(ctx: Context, agent: AgentFace | undefined): ModelPick | undefined {
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
    const options = agent?.options
    const fromOptions = typeof options?.provider === 'string' && typeof options.model === 'string'
      ? concreteRoute({ provider: options.provider, model: options.model })
      : undefined
    if (fromOptions !== undefined) return fromOptions
    const projected = concreteRoute(projectedSelection(ctx, agent))
    if (projected !== undefined) return projected
    const defaults = softService<{ currentSelection?: () => ModelPick | undefined }>(ctx, 'agentDefaultModel')
    return concreteRoute(defaults?.currentSelection?.())
  } catch {
    return undefined
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

  // `agent/request` copies the saved selection onto the call, then the loop
  // calls `prepareCall`. The admitted user batch is not in the session log
  // yet, so the latest `agent/pre-step` decision is the turn text. The map
  // stores text only; the resolved route for this turn is cached separately.
  const notes = new WeakMap<object, TurnNote>()
  // Same agent (or, with no agent, the config object) currently inside
  // resolve. Nested `prepareCall`s — the classifier — pass through.
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
    const inner = llm.prepareCall.bind(llm)
    const wrapped: typeof llm.prepareCall = async (config, signal, configure) => {
      const keyProbe = activeAgent(ctx) ?? config
      const depth = resolving.get(keyProbe) ?? 0
      if (depth > 0 || !isAutoModel(config)) return inner(config, signal, configure)
      const agent = activeAgent(ctx)
      const key = agent ?? config
      resolving.set(key, (resolving.get(key) ?? 0) + 1)
      try {
        const settings = options.settings()
        const map = autoRouteMapOf(settings)
        const note = (agent === undefined ? undefined : notes.get(agent)) ?? loggedTurn(asAgent(agent))
        const classify = settings.autoClassifierEnabled
          ? createClassifier({ prepareCall: inner }, map.classifier)
          : undefined
        const mapped = await resolveAutoRoute({
          text: note?.text ?? '',
          feature: 'session',
          toolHeavy: note?.toolHeavy ?? false,
          map,
          classifierEnabled: settings.autoClassifierEnabled,
          classify,
          isAvailable: (provider, model) => provider !== '' && model !== '' && !isAutoModel({ provider, model }),
          signal,
          fallback: fallbackRoute(ctx, asAgent(agent)),
        })
        if (agent !== undefined) setSessionResolvedRoute(agent, mapped)
        return await inner(routeConfig(config, mapped), signal, configure)
      } finally {
        const next = (resolving.get(key) ?? 1) - 1
        if (next <= 0) resolving.delete(key)
        else resolving.set(key, next)
      }
    }
    llm.prepareCall = wrapped
    return () => {
      if (llm.prepareCall === wrapped) llm.prepareCall = inner
    }
  })
}
