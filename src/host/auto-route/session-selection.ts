import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface SessionModelPick {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

type AgentModelFace = {
  readonly current?: () => SessionModelPick | undefined
  readonly select?: (selection: SessionModelPick) => void
}

type LiveAgentFace = {
  readonly model?: AgentModelFace
  readonly options?: { readonly provider?: string, readonly model?: string, readonly reasoningEffort?: string }
}

/**
 * Prefer `agent.model.current()` (0.2.2 domain API) over deprecated
 * `sessionProjections.stateOf(session, 'modelSelection')`.
 * Same priority as AgentModel: pending → lastUsed → live options → host default.
 */
export function projectedSessionModel(ctx: Context, session: Session): SessionModelPick {
  try {
    const agents = ctx.get('agents') as
      | { get?: (id: SessionId) => LiveAgentFace | undefined }
      | undefined
    const agent = agents?.get?.(session.id)
    const fromModel = agent?.model?.current?.()
    if (fromModel !== undefined
      && typeof fromModel.provider === 'string'
      && fromModel.provider !== ''
      && typeof fromModel.model === 'string'
      && fromModel.model !== '') {
      return {
        provider: fromModel.provider,
        model: fromModel.model,
        ...(typeof fromModel.reasoningEffort === 'string'
          ? { reasoningEffort: fromModel.reasoningEffort }
          : {}),
      }
    }
    const options = agent?.options
    if (typeof options?.provider === 'string' && options.provider !== ''
      && typeof options.model === 'string' && options.model !== '') {
      return {
        provider: options.provider,
        model: options.model,
        ...(typeof options.reasoningEffort === 'string'
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
      }
    }
  } catch {
    // Inactive context / missing inject — fall through to default model.
  }
  try {
    const defaults = ctx.get('agentDefaultModel') as { currentSelection?: () => SessionModelPick } | undefined
    const selection = defaults?.currentSelection?.()
    if (selection !== undefined) return selection
  } catch {
    // ignore
  }
  return { provider: '', model: '' }
}
