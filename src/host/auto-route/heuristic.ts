import type { AutoTier, HeuristicInput } from './types.ts'

export const DEPTH_RE = /深入|仔细|分析|plan|reason|thorough/i

export function pickTierHeuristic(input: HeuristicInput): AutoTier {
  const { text, feature, toolHeavy } = input
  const len = text.length
  const hasDepth = DEPTH_RE.test(text)

  if (feature === 'compact') {
    return 'thinking'
  }

  let tier: AutoTier

  if (len >= 400 && hasDepth) {
    tier = 'pro'
  } else if (feature === 'predict' && len < 80) {
    tier = 'instant'
  } else if (len < 80 && !hasDepth) {
    tier = 'instant'
  } else if (len >= 80) {
    tier = 'thinking'
  } else {
    tier = 'instant'
  }

  if (toolHeavy && tier === 'instant') {
    tier = 'thinking'
  }

  return tier
}
