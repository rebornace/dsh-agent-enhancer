import type { ContextPressureProjection, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type ContextInspectCategory = 'system' | 'tools' | 'messages'

/** Finer row kind inside the official system / tools / messages buckets. */
export type ContextInspectKind =
  | 'system'
  | 'tools'
  | 'user'
  | 'inject'
  | 'assistant'
  | 'tool'
  | 'developer'

export interface ContextInspectItem {
  readonly id: string
  readonly title: string
  /** Short list preview. */
  readonly detail: string
  /** Longer text for the in-pane secondary detail. */
  readonly body: string
  readonly tokens: number
  readonly kind: ContextInspectKind
  /** True when this surface node arrived via a replace (compaction / prune / rewrite). */
  readonly replaced: boolean
}

export interface ContextInspectPressure {
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

export type ContextInspectEventKind = 'compact' | 'prune' | 'replace'

export interface ContextInspectEventMark {
  readonly id: string
  readonly kind: ContextInspectEventKind
  readonly seq: number
  readonly shadowed: number
  readonly title: string
}

export interface ContextInspectRequest {
  readonly sessionId: SessionId
  readonly category: ContextInspectCategory
}

export interface ContextInspectResult {
  readonly sessionId: SessionId
  readonly category: ContextInspectCategory
  readonly totalTokens: number
  readonly approximate: true
  readonly items: readonly ContextInspectItem[]
  readonly pressure: ContextInspectPressure
  readonly events: readonly ContextInspectEventMark[]
}

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const PREVIEW_LIMIT = 160
const BODY_LIMIT = 12_000
const MAX_ITEMS = 80
const MAX_EVENT_MARKS = 12

function textBlocks(blocks: readonly { type?: string, text?: string }[]): string[] {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text.trim())
    }
  }
  return parts
}

function textFromBlocks(blocks: readonly { type?: string, text?: string }[]): string {
  return textBlocks(blocks).join('\n\n')
}

function allocateTokens(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return []
  if (weights.length === 1) return [total]
  const sum = weights.reduce((acc, weight) => acc + weight, 0)
  if (sum <= 0) {
    const even = Math.floor(total / weights.length)
    const parts = weights.map(() => even)
    parts[parts.length - 1] = total - even * (weights.length - 1)
    return parts
  }
  const raw = weights.map(weight => (total * weight) / sum)
  const floored = raw.map(value => Math.floor(value))
  let remain = total - floored.reduce((acc, value) => acc + value, 0)
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)
  for (const entry of order) {
    if (remain <= 0) break
    floored[entry.index] = (floored[entry.index] ?? 0) + 1
    remain -= 1
  }
  return floored
}

function systemTitle(text: string, index: number, total: number): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? ''
  if (firstLine !== '' && firstLine.length <= 48) return firstLine
  if (total <= 1) return 'System'
  return `System · ${index + 1}`
}

function clip(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact
  return `${compact.slice(0, Math.max(0, limit - 1))}…`
}

function preserveBody(text: string, limit = BODY_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length <= limit) return trimmed
  return `${trimmed.slice(0, Math.max(0, limit - 1))}…`
}

function isReplaced(event: SessionEvent): boolean {
  const op = event.surfaceOp
  return typeof op === 'object' && op !== null && op.op === 'replace'
}

function shadowedCount(event: SessionEvent): number {
  const op = event.surfaceOp
  if (typeof op !== 'object' || op === null || op.op !== 'replace') return 0
  return Math.max(0, Number(op.endSeq) - Number(op.startSeq) + 1)
}

function classifyReplace(event: SessionEvent): ContextInspectEventKind {
  const type = String(event.type)
  if (type.includes('prune')) return 'prune'
  if (type.includes('compact')) return 'compact'
  const shadowed = shadowedCount(event)
  if (shadowed >= 3) return 'compact'
  if (event.type === 'tool/result' && shadowed >= 2) return 'prune'
  return 'replace'
}

function collectEventMarks(events: readonly SessionEvent[]): ContextInspectEventMark[] {
  const marks: ContextInspectEventMark[] = []
  for (const event of events) {
    if (!isReplaced(event)) continue
    const kind = classifyReplace(event)
    const shadowed = shadowedCount(event)
    marks.push({
      id: `evt:${event.seq}`,
      kind,
      seq: Number(event.seq),
      shadowed,
      title: `${kind} · seq ${event.seq}`,
    })
  }
  if (marks.length <= MAX_EVENT_MARKS) return marks
  return marks.slice(marks.length - MAX_EVENT_MARKS)
}

function sourceKind(event: SessionEvent): string | undefined {
  if (event.type === 'user/message') {
    const source = (event.data as { source?: { kind?: string } }).source
    return typeof source?.kind === 'string' ? source.kind : undefined
  }
  if (event.type === 'assistant/message' || event.type === 'tool/result'
    || event.type === 'system/message' || event.type === 'developer/message') {
    const source = (event.data as { message?: { source?: { kind?: string } } }).message?.source
    return typeof source?.kind === 'string' ? source.kind : undefined
  }
  return undefined
}

function messageMeta(event: SessionEvent): { kind: ContextInspectKind, title: string } {
  switch (event.type) {
    case 'system/message':
      return { kind: 'system', title: 'System' }
    case 'developer/message':
      return { kind: 'developer', title: 'Developer' }
    case 'user/message': {
      const kind = sourceKind(event)
      if (kind === undefined || kind === 'user') return { kind: 'user', title: 'User' }
      return { kind: 'inject', title: `Inject · ${kind}` }
    }
    case 'assistant/message':
      return { kind: 'assistant', title: 'Assistant' }
    case 'tool/result': {
      const message = event.data.message as { id?: string, name?: string }
      return {
        kind: 'tool',
        title: `Tool · ${message.name ?? message.id ?? 'unknown'}`,
      }
    }
    default:
      return { kind: 'developer', title: event.type }
  }
}

function blocksOf(event: SessionEvent): readonly { type?: string, text?: string }[] {
  switch (event.type) {
    case 'user/message':
      return event.data.content as never
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result':
      return event.data.message.content as never
    default:
      return []
  }
}

function eventTexts(event: SessionEvent): { preview: string, body: string } {
  const raw = textFromBlocks(blocksOf(event)) || '(empty)'
  return {
    preview: clip(raw, PREVIEW_LIMIT),
    body: preserveBody(raw),
  }
}

function eventBySeq(events: readonly SessionEvent[]): Map<number, SessionEvent> {
  const map = new Map<number, SessionEvent>()
  for (const event of events) map.set(event.seq, event)
  return map
}

function latestRequestHeader(events: readonly SessionEvent[]): unknown {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'request/header') return event.data.header
  }
  return undefined
}

function toolParameterKeys(parameters: unknown): string {
  if (parameters === null || typeof parameters !== 'object') return ''
  const props = (parameters as { properties?: Record<string, unknown> }).properties
  if (props === undefined || typeof props !== 'object') return ''
  const keys = Object.keys(props)
  if (keys.length === 0) return ''
  return `parameters: ${keys.slice(0, 24).join(', ')}${keys.length > 24 ? '…' : ''}`
}

function toolItems(header: unknown): ContextInspectItem[] {
  const tools = (header as { tools?: readonly unknown[] } | undefined)?.tools
  if (!Array.isArray(tools) || tools.length === 0) return []
  const items: ContextInspectItem[] = []
  for (let index = 0; index < tools.length && items.length < MAX_ITEMS; index += 1) {
    const tool = tools[index] as {
      name?: string
      description?: string
      parameters?: unknown
    } | undefined
    const encoded = JSON.stringify(tool ?? {})
    const tokens = Math.ceil(encoded.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    const name = typeof tool?.name === 'string' && tool.name !== '' ? tool.name : `tool-${index + 1}`
    const description = typeof tool?.description === 'string' ? tool.description.trim() : ''
    const paramKeys = toolParameterKeys(tool?.parameters)
    const bodyParts = [description || 'Tool schema', paramKeys].filter(part => part !== '')
    const body = preserveBody(bodyParts.join('\n\n'))
    items.push({
      id: `tool:${name}:${index}`,
      title: name,
      detail: clip(description || paramKeys || 'Tool schema', PREVIEW_LIMIT),
      body,
      tokens,
      kind: 'tools',
      replaced: false,
    })
  }
  return items
}

export function pressureFromProjection(value: ContextPressureProjection | undefined): ContextInspectPressure {
  if (value === undefined) return {}
  return {
    projectedTokens: value.projectedTokens,
    contextWindow: value.contextWindow,
  }
}

export function inspectContextCategory(
  session: Session,
  category: ContextInspectCategory,
  tokenMeter: TokenMeter,
): Omit<ContextInspectResult, 'sessionId' | 'pressure'> {
  const events = session.snapshotEvents()
  const bySeq = eventBySeq(events)
  const marks = collectEventMarks(events)

  if (category === 'tools') {
    const items = toolItems(latestRequestHeader(events))
    return {
      category,
      approximate: true,
      totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
      items,
      events: marks,
    }
  }

  const measurement = tokenMeter.measure(session)
  const items: ContextInspectItem[] = []
  for (const node of measurement.nodes) {
    if (items.length >= MAX_ITEMS) break
    const event = bySeq.get(node.seq)
    if (event === undefined) continue
    const isSystem = event.type === 'system/message'
    if (category === 'system' && !isSystem) continue
    if (category === 'messages' && isSystem) continue

    const replaced = isReplaced(event)

    // Official meter keeps one surviving system/message node; when that node
    // carries multiple text blocks, expose each block as its own list row.
    if (category === 'system') {
      const parts = textBlocks(blocksOf(event))
      if (parts.length > 1) {
        const tokenParts = allocateTokens(node.heuristicTokens, parts.map(part => part.length))
        for (let index = 0; index < parts.length && items.length < MAX_ITEMS; index += 1) {
          const part = parts[index]!
          items.push({
            id: `seq:${node.seq}:b${index}`,
            title: systemTitle(part, index, parts.length),
            detail: clip(part, PREVIEW_LIMIT),
            body: preserveBody(part),
            tokens: tokenParts[index] ?? 0,
            kind: 'system',
            replaced,
          })
        }
        continue
      }
    }

    const meta = messageMeta(event)
    const texts = eventTexts(event)
    items.push({
      id: `seq:${node.seq}`,
      title: meta.title,
      detail: texts.preview,
      body: texts.body,
      tokens: node.heuristicTokens,
      kind: meta.kind,
      replaced,
    })
  }

  return {
    category,
    approximate: true,
    totalTokens: items.reduce((sum, item) => sum + item.tokens, 0),
    items,
    events: marks,
  }
}
