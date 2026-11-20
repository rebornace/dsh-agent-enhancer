/**
 * Values a saved flow needs at run time: what counts as a date, how to read
 * "上周" without asking a model, and which recorded values are worth turning
 * into a variable in the first place.
 *
 * Everything here is deterministic and local. A model turn is the expensive
 * part, so the common phrasings ("这个月", "上周五", "today") never reach it.
 */

import type { DemoStep } from './demo.ts'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** 2026-11-01 / 2026/11/1 / 2026年11月1日 */
const LOOSE_DATE = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SEARCH_FIELD = /搜索|查找|关键词|关键字|查询|search|query|filter|keyword|^q$/iu

const pad = (value: number): string => String(value).padStart(2, '0')

/** Local ISO date (no UTC shift: a flow runs in the user's day). */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

/** Monday of the week `date` is in. */
function weekStart(date: Date): Date {
  const offset = (date.getDay() + 6) % 7
  return addDays(date, -offset)
}

function monthStart(date: Date, offsetMonths: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + offsetMonths, 1)
}

function quarterStart(date: Date, offsetQuarters: number): Date {
  const quarter = Math.floor(date.getMonth() / 3) + offsetQuarters
  return new Date(date.getFullYear(), quarter * 3, 1)
}

const WEEKDAY: Record<string, number> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6,
}

type Relative = (now: Date) => Date

const EXACT: Record<string, Relative> = {
  今天: now => now,
  今日: now => now,
  today: now => now,
  昨天: now => addDays(now, -1),
  昨日: now => addDays(now, -1),
  yesterday: now => addDays(now, -1),
  前天: now => addDays(now, -2),
  明天: now => addDays(now, 1),
  tomorrow: now => addDays(now, 1),
  后天: now => addDays(now, 2),
  本周: now => weekStart(now),
  这周: now => weekStart(now),
  本星期: now => weekStart(now),
  thisweek: now => weekStart(now),
  上周: now => addDays(weekStart(now), -7),
  lastweek: now => addDays(weekStart(now), -7),
  下周: now => addDays(weekStart(now), 7),
  nextweek: now => addDays(weekStart(now), 7),
  本月: now => monthStart(now, 0),
  这个月: now => monthStart(now, 0),
  thismonth: now => monthStart(now, 0),
  上月: now => monthStart(now, -1),
  上个月: now => monthStart(now, -1),
  lastmonth: now => monthStart(now, -1),
  下月: now => monthStart(now, 1),
  下个月: now => monthStart(now, 1),
  nextmonth: now => monthStart(now, 1),
  本季度: now => quarterStart(now, 0),
  这季度: now => quarterStart(now, 0),
  thisquarter: now => quarterStart(now, 0),
  上季度: now => quarterStart(now, -1),
  lastquarter: now => quarterStart(now, -1),
  下季度: now => quarterStart(now, 1),
  nextquarter: now => quarterStart(now, 1),
  今年: now => new Date(now.getFullYear(), 0, 1),
  本年: now => new Date(now.getFullYear(), 0, 1),
  thisyear: now => new Date(now.getFullYear(), 0, 1),
  去年: now => new Date(now.getFullYear() - 1, 0, 1),
  lastyear: now => new Date(now.getFullYear() - 1, 0, 1),
  明年: now => new Date(now.getFullYear() + 1, 0, 1),
  nextyear: now => new Date(now.getFullYear() + 1, 0, 1),
}

/** 周一 / 星期一 / 礼拜一, optionally prefixed by 上 / 下 / 本 / 这. */
const WEEKDAY_PHRASE = /^(上|下|本|这)?(?:周|星期|礼拜)([一二三四五六日天])$/u

/**
 * Read one whole value as a date. Only an exact phrase counts, so a search term
 * like "上周的新闻" is left alone.
 */
export function resolveDatePhrase(raw: string, now: Date = new Date()): { readonly iso: string; readonly phrase: string } | null {
  const text = raw.trim()
  if (text === '') return null
  const day = startOfDay(now)
  const exact = EXACT[text.toLowerCase()]
  if (exact !== undefined) return { iso: isoDate(exact(day)), phrase: text }
  const weekday = WEEKDAY_PHRASE.exec(text)
  if (weekday !== null) {
    const scope = weekday[1]
    const index = WEEKDAY[weekday[2]!]
    if (index === undefined) return null
    const base = scope === '上'
      ? addDays(weekStart(day), -7)
      : scope === '下'
        ? addDays(weekStart(day), 7)
        : weekStart(day)
    return { iso: isoDate(addDays(base, index)), phrase: text }
  }
  const loose = LOOSE_DATE.exec(text)
  if (loose !== null) {
    const month = Number(loose[2])
    const date = Number(loose[3])
    if (month < 1 || month > 12 || date < 1 || date > 31) return null
    return { iso: `${loose[1]}-${pad(month)}-${pad(date)}`, phrase: text }
  }
  return null
}

/** Values that already look like a date a human would type. */
export function looksLikeDateValue(value: string): boolean {
  const text = value.trim()
  return ISO_DATE.test(text) || LOOSE_DATE.test(text)
}

/**
 * Resolve a supplied value when the variable is about dates. Anything else is
 * returned untouched, so keywords and amounts never get rewritten.
 */
export function resolveVariableValue(
  value: string,
  dateVariable: boolean,
  now: Date = new Date(),
): { readonly value: string; readonly resolvedFrom?: string } {
  if (!dateVariable) return { value }
  const parsed = resolveDatePhrase(value, now)
  return parsed === null ? { value } : { value: parsed.iso, resolvedFrom: parsed.phrase }
}

/** Is this variable about a date? Judged from its label, name and default. */
export function isDateVariable(variable: {
  readonly name: string
  readonly label?: string
  readonly default?: string
}): boolean {
  if (variable.default !== undefined && looksLikeDateValue(variable.default)) return true
  const text = `${variable.label ?? ''} ${variable.name}`
  return /日期|时间|开始|结束|截止|起止|date|from|to|start|end|until|since/iu.test(text)
}

export interface RecipeSuggestion {
  /** Index of the fill step this variable would replace. */
  readonly index: number
  /** A human name, taken from the page: 「开始日期」. */
  readonly label: string
  /** The value recorded in that step. */
  readonly value: string
}

/**
 * High-confidence candidates after a recording: dates, e-mail addresses, and a
 * search box that clearly holds a query. Everything else stays a literal until
 * the user says otherwise — a wrong suggestion costs more trust than a missing one.
 */
export function suggestRecipeVariables(steps: readonly DemoStep[]): RecipeSuggestion[] {
  const seen = new Set<string>()
  const suggestions: RecipeSuggestion[] = []
  steps.forEach((step, index) => {
    if (suggestions.length >= 3) return
    if (step.kind !== 'fill' || step.masked) return
    const value = step.value.trim()
    if (value === '') return
    // Already a placeholder: nothing to suggest.
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/u.test(value)) return
    const label = step.name.trim()
    let kind: string | null = null
    if (looksLikeDateValue(value) || resolveDatePhrase(value) !== null) kind = 'date'
    else if (EMAIL.test(value)) kind = 'email'
    else if (SEARCH_FIELD.test(label) && value.length <= 40) kind = 'search'
    if (kind === null) return
    const key = `${label}\u0000${value}`
    if (seen.has(key)) return
    seen.add(key)
    suggestions.push({ index, label: label === '' ? kind : label, value: value.slice(0, 60) })
  })
  return suggestions
}
