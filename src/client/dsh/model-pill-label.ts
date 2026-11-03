import { isAutoModel, isFollowSessionModel } from '../../config.ts'
import type { AuxiliaryModelSettings } from '../../config.ts'
import {
  encodeAutoSelection,
  encodeEffortSelection,
  encodeFollowSelection,
  encodeModelSelection,
  encodeUnconfiguredSelection,
} from './model-catalog.ts'

export interface ModelCatalogModelLike {
  readonly id: string
  readonly name: string
  readonly reasoning?: { readonly efforts: readonly { readonly id: string; readonly name: string }[] }
}

export interface ModelProviderGroupLike {
  readonly id: string
  readonly models: readonly ModelCatalogModelLike[]
}

function findModel(
  groups: readonly ModelProviderGroupLike[],
  provider: string,
  model: string,
): ModelCatalogModelLike | undefined {
  return groups.find(group => group.id === provider)?.models.find(entry => entry.id === model)
}

export function isUnconfiguredAutoTierMapping(selection: AuxiliaryModelSettings): boolean {
  return !isAutoModel(selection) && selection.provider === '' && selection.model === ''
}

export function pillLabel(
  selection: AuxiliaryModelSettings,
  groups: readonly ModelProviderGroupLike[],
  followLabel: string,
  autoLabel: string,
  unconfiguredLabel?: string,
): string {
  if (isAutoModel(selection)) return autoLabel
  if (unconfiguredLabel !== undefined && isUnconfiguredAutoTierMapping(selection)) {
    return unconfiguredLabel
  }
  if (isFollowSessionModel(selection)) return followLabel
  const model = findModel(groups, selection.provider, selection.model)
  const name = model?.name ?? selection.model
  if (selection.reasoningEffort === '') return name
  const effort = model?.reasoning?.efforts.find(entry => entry.id === selection.reasoningEffort)
  return `${name} · ${effort?.name ?? selection.reasoningEffort}`
}

export function selectedPillMenuId(
  selection: AuxiliaryModelSettings,
  groups: readonly ModelProviderGroupLike[],
  options?: { readonly tierMapping?: boolean },
): string {
  if (isAutoModel(selection)) return encodeAutoSelection()
  if (options?.tierMapping === true && isUnconfiguredAutoTierMapping(selection)) {
    return encodeUnconfiguredSelection()
  }
  if (isFollowSessionModel(selection)) return encodeFollowSelection()
  const model = findModel(groups, selection.provider, selection.model)
  if ((model?.reasoning?.efforts.length ?? 0) > 0) {
    return encodeEffortSelection(selection.provider, selection.model, selection.reasoningEffort)
  }
  return encodeModelSelection(selection.provider, selection.model)
}
