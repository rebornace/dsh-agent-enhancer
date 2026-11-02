import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-llm'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'

/**
 * Build the same provider/model catalog Desktop selectors use, via the live
 * `llm` registry only (no session-controller import edge).
 */
export async function buildAuxiliaryModelCatalog(ctx: Context): Promise<ModelCatalog> {
  const selection = ctx.agentDefaultModel.currentSelection()
  const providers = ctx.llm.listProviders()
  const catalog = await Promise.all(providers.map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning = resolved.reasoning === undefined
          ? undefined
          : {
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: String(effort.id),
              name: effort.name,
              ...(effort.description === undefined ? {} : { description: effort.description }),
            })),
            ...(resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: String(resolved.reasoning.defaultEffort) }),
          }
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
        }
      }))
      return {
        kind: 'group' as const,
        group: { id: provider.id, name: provider.name, models: entries },
      }
    } catch (error) {
      return {
        kind: 'failure' as const,
        failure: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))

  const groups = catalog
    .flatMap(item => item.kind === 'group' ? [item.group] : [])
    .filter(group => group.models.length > 0)

  return {
    default: {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string'
        ? { reasoningEffort: selection.reasoningEffort }
        : {}),
    },
    routableProviders: groups.map(group => group.id),
    groups,
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}
