import type { AutoTier, HeuristicInput } from './types.ts'

/** Bilingual depth / thoroughness cues (raise complexity). */
export const DEPTH_RE = /深入|仔细|彻底|详细|全面|分析|推理|论证|推演|权衡|对比|评估|排查|根因|架构|设计|重构|并发|死锁|竞态|性能|优化策略|证明|推导|\bplan\b|\breason\b|\bthorough\b|\banaly[sz]e\b|\bdeep\s*dive\b|\broot\s*cause\b|\barchitect(?:ure|ural)?\b|\brefactor\b|\bconcurren(?:cy|t)\b|\bdeadlock\b|\brace\s*condition\b|\btrade-?offs?\b|\bprove\b|\bstep\s*by\s*step\b/i

/** Multi-step / sequential work cues. */
const MULTI_STEP_RE = /第一步|第二步|第三步|接下来|然后请|分步|逐步|依次|按顺序|\bstep\s*[1-9]\b|\bfirst\b.+\bthen\b|\bnext\b.+\bthen\b|\band\s+then\b|\bmulti-?step\b|\btodo\b|\bchecklist\b/i

/** Code / diff / patch presence. */
const CODE_FENCE_RE = /```[\s\S]{20,}?```/
const DIFF_RE = /^(?:diff\s+--git|index\s+[0-9a-f]+\.\.|@@\s+[-+]\d+)/m
const INLINE_CODE_HEAVY_RE = /(?:^|\n)\s*(?:import\s+|from\s+\S+\s+import|function\s+\w+|const\s+\w+\s*=|class\s+\w+|def\s+\w+|fn\s+\w+|public\s+class)\b/m

/** Error / stack signals that usually need careful diagnosis. */
const ERROR_STACK_RE = /(?:Error|Exception|TypeError|ReferenceError|panic:|Traceback \(most recent call last\)|FATAL|SIGSEGV|ECONNREFUSED|ENOENT)\b|at\s+\S+\s+\([^)]+:\d+:\d+\)/

/**
 * Sensitive topics: floor at least thinking (raise-only).
 * Two or more distinct hits raise the floor to pro.
 */
const SENSITIVE_RES: readonly RegExp[] = [
  /生产环境|线上故障|正式环境|\bproduction\b|\bprod\b(?![a-z])/i,
  /密钥|密码|凭证|私钥|token\b|api[_\s-]?key|credential|secret|password|passwd/i,
  /删库|删除全部|rm\s+-rf|drop\s+table|destroy\s+all|wipe\s+data/i,
  /账单|支付|扣费|billing|payment|invoice|refund/i,
  /权限提升|越权|注入攻击|sql\s*injection|xss\b|rce\b|privilege\s*escalation/i,
]

export interface HeuristicScore {
  readonly tier: AutoTier
  readonly score: number
  readonly floor: AutoTier
  readonly signals: readonly string[]
}

function clamp01(value: number): number {
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function lengthContribution(len: number): { readonly points: number, readonly signal?: string } {
  if (len < 40) return { points: 0 }
  if (len < 120) return { points: 0.08 + ((len - 40) / 80) * 0.1, signal: 'length-short' }
  if (len < 400) return { points: 0.22 + ((len - 120) / 280) * 0.18, signal: 'length-medium' }
  if (len < 1200) return { points: 0.4 + ((len - 400) / 800) * 0.18, signal: 'length-long' }
  return { points: 0.62, signal: 'length-very-long' }
}

function countHits(text: string, pattern: RegExp, limit: number): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const global = new RegExp(pattern.source, flags)
  let hits = 0
  for (const _ of text.matchAll(global)) {
    hits += 1
    if (hits >= limit) break
  }
  return hits
}

function sensitiveHitCount(text: string): number {
  let hits = 0
  for (const pattern of SENSITIVE_RES) {
    if (pattern.test(text)) hits += 1
  }
  return hits
}

function maxTier(left: AutoTier, right: AutoTier): AutoTier {
  const order: Record<AutoTier, number> = { instant: 0, thinking: 1, pro: 2 }
  return order[left] >= order[right] ? left : right
}

function tierFromScore(score: number): AutoTier {
  if (score < 0.28) return 'instant'
  if (score < 0.58) return 'thinking'
  return 'pro'
}

/**
 * Weighted bilingual complexity score for Auto routing.
 * Floors only raise the tier (never lower a high score).
 */
export function scoreHeuristic(input: HeuristicInput): HeuristicScore {
  const text = input.text
  const len = text.length
  const signals: string[] = []
  let score = 0

  const length = lengthContribution(len)
  score += length.points
  if (length.signal !== undefined) signals.push(length.signal)

  const depthHits = countHits(text, DEPTH_RE, 4)
  if (depthHits > 0) {
    score += Math.min(0.36, 0.12 * depthHits)
    signals.push(`depth×${depthHits}`)
  }

  if (CODE_FENCE_RE.test(text) || DIFF_RE.test(text) || INLINE_CODE_HEAVY_RE.test(text)) {
    score += 0.18
    signals.push('code')
  }

  if (ERROR_STACK_RE.test(text)) {
    score += 0.16
    signals.push('error-stack')
  }

  if (MULTI_STEP_RE.test(text)) {
    score += 0.14
    signals.push('multi-step')
  }

  const sensitive = sensitiveHitCount(text)
  if (sensitive > 0) {
    score += Math.min(0.2, 0.1 * sensitive)
    signals.push(`sensitive×${sensitive}`)
  }

  if (input.feature === 'optimize' && len >= 80) {
    score += 0.06
    signals.push('feature-optimize')
  }
  if (input.feature === 'predict' && len < 80 && depthHits === 0 && sensitive === 0) {
    score = Math.min(score, 0.2)
    signals.push('feature-predict-short')
  }

  score = clamp01(score)

  let floor: AutoTier = 'instant'
  if (input.feature === 'compact') {
    floor = maxTier(floor, 'thinking')
    signals.push('floor-compact')
  }
  if (input.toolHeavy === true) {
    floor = maxTier(floor, 'thinking')
    signals.push('floor-tools')
  }
  if (sensitive >= 1) {
    floor = maxTier(floor, 'thinking')
    signals.push('floor-sensitive')
  }
  if (sensitive >= 2) {
    floor = maxTier(floor, 'pro')
    signals.push('floor-sensitive-pro')
  }
  if (depthHits >= 2 && len >= 400) {
    floor = maxTier(floor, 'pro')
    signals.push('floor-long-depth')
  }

  const scored = tierFromScore(score)
  const tier = maxTier(scored, floor)
  return { tier, score, floor, signals }
}

export function pickTierHeuristic(input: HeuristicInput): AutoTier {
  return scoreHeuristic(input).tier
}
