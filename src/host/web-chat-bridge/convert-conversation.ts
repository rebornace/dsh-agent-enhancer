/**
 * Convert one DeepSeek share / history conversation into a DSH Session seed.
 * Adapted from `@deepseek-ai/dsh-deepseek-chat-import` `conversation.ts`
 * (no ZIP archive, no image attachments).
 */

import { randomUUID } from 'node:crypto'
import {
  MessageId,
  ToolCallId,
  type AssistantMessage,
  type ContentBlock,
  type LlmFailure,
  type SystemMessage,
  type ToolCallBlock,
  type ToolResultMessage,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  fetchMetaFromValue,
  formatFetchOutput,
  formatSearchOutput,
  searchMetaFromValue,
} from '@deepseek-ai/dsh-tool-web'
import type { WebFetchResult, WebSearchResult } from '@deepseek-ai/dsh-web'
import type {
  WebChatFragment,
  WebChatRichMessage,
} from './fragments.ts'

/** Provider / model recorded on every imported assistant message. */
export const WEB_CHAT_IMPORTED_MODEL_SOURCE = {
  provider: 'web-chat-bridge',
  model: 'imported-history',
} as const

const FETCH_OUTPUT_CHARS = 4_000

const UNFINISHED_STATUS_CODES: ReadonlyMap<string, string> = new Map([
  ['FAILED', 'DEEPSEEK_EXPORT_FAILED'],
  ['TIMEOUT', 'DEEPSEEK_EXPORT_TIMEOUT'],
  ['CONTEXT_LENGTH_EXCEEDED', 'DEEPSEEK_EXPORT_CONTEXT_LENGTH_EXCEEDED'],
  ['INCOMPLETE', 'DEEPSEEK_EXPORT_INCOMPLETE'],
  ['WIP', 'DEEPSEEK_EXPORT_WIP'],
])

export class WebChatConvertError extends Error {
  override readonly name = 'WebChatConvertError'
}

export interface ConvertWebChatConversationInput {
  readonly title: string | null
  readonly currentMessageId?: number | null
  readonly messages: readonly WebChatRichMessage[]
}

export interface ConvertWebChatConversationOptions {
  readonly createId?: () => string
  /** Prefixed onto the first user message body (import provenance). */
  readonly provenancePrefix?: string
}

export interface ConvertedWebChatConversation {
  readonly title: string | null
  readonly events: readonly SessionEvent[]
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type EventInput = DistributiveOmit<SessionEvent, 'seq' | 'time'>

interface ReplyStep {
  readonly content: ContentBlock[]
  readonly calls: PendingCall[]
  elapsedMs: number
  stage: number | null
}

interface PendingCall {
  readonly block: ToolCallBlock
  readonly result: readonly ContentBlock[]
  readonly isError: boolean
  readonly meta?: ReturnType<typeof searchMetaFromValue>
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value === null || value === undefined || value.trim().length === 0
    ? undefined
    : value
}

/**
 * Select the imported branch: path to `currentMessageId`, or the greatest id,
 * or the full linear list when no parent links exist.
 * Share payloads sometimes mix `message_id` with orphan `parent_id`s — broken
 * links are dropped so import still succeeds in array order.
 */
export function selectWebChatBranch(
  messages: readonly WebChatRichMessage[],
  currentMessageId?: number | null,
): readonly WebChatRichMessage[] {
  if (messages.length === 0) {
    throw new WebChatConvertError('conversation has no messages')
  }

  const ids = new Set(messages.map(message => message.id))
  const resolved = messages.map(message => {
    if (message.parent_id === null || ids.has(message.parent_id)) return message
    return { ...message, parent_id: null }
  })

  const hasParents = resolved.some(message => message.parent_id !== null)
  if (!hasParents) return resolved

  const byId = new Map<number, WebChatRichMessage>()
  let newest: WebChatRichMessage | undefined
  for (const message of resolved) {
    if (byId.has(message.id)) {
      // Duplicate ids break tree identity — keep array order (share-safe).
      return resolved
    }
    byId.set(message.id, message)
    if (newest === undefined || message.id > newest.id) newest = message
  }
  if (newest === undefined) {
    throw new WebChatConvertError('conversation has no messages')
  }

  const selected = currentMessageId === null || currentMessageId === undefined
    ? undefined
    : byId.get(currentMessageId)
  const chain: WebChatRichMessage[] = []
  for (let message = selected ?? newest; ;) {
    if (chain.length === byId.size) {
      // Cycle — fall back to linear import rather than failing the whole share.
      return resolved
    }
    chain.push(message)
    if (message.parent_id === null) return chain.reverse()
    const parent = byId.get(message.parent_id)
    if (parent === undefined) return resolved
    message = parent
  }
}

export function convertWebChatConversation(
  input: ConvertWebChatConversationInput,
  options: ConvertWebChatConversationOptions = {},
): ConvertedWebChatConversation {
  const createId = options.createId ?? (() => randomUUID())
  const chain = selectWebChatBranch(input.messages, input.currentMessageId)
  const log = new LogBuilder(createId, options.provenancePrefix ?? '')
  const title = input.title !== null && input.title.trim() !== ''
    ? input.title.trim()
    : null

  let turn = 0
  let withdrawn = 0
  for (let index = 0; index < chain.length; index++) {
    const user = chain[index]!
    if (user.role !== 'USER') continue
    const next = chain[index + 1]
    const reply = next?.role === 'ASSISTANT' ? next : undefined
    if (reply !== undefined) index++
    if (reply?.status === 'CONTENT_FILTER') {
      withdrawn++
      continue
    }
    turn++
    log.turn(turn, user, reply)
    if (turn === 1 && title !== null) {
      log.add({
        type: 'session/title',
        data: { title, messageSeqs: [], source: { kind: 'user' } },
      })
    }
  }

  if (turn === 0) {
    throw new WebChatConvertError(
      withdrawn === 0
        ? 'conversation has no user message'
        : 'every question of the conversation was withdrawn by content filtering',
    )
  }

  return { title, events: log.events }
}

class LogBuilder {
  readonly events: SessionEvent[] = []
  private time = Date.now()

  constructor(
    private readonly createId: () => string,
    private readonly provenancePrefix: string,
  ) {}

  add(event: EventInput): SessionSeq {
    const seq = SessionSeq(this.events.length)
    this.events.push({ ...event, seq, time: this.time } as SessionEvent)
    return seq
  }

  turn(turn: number, user: WebChatRichMessage, reply: WebChatRichMessage | undefined): void {
    this.add({ type: 'turn/start', data: { turn } })
    let step = 1
    this.add({ type: 'step/start', data: { turn, step } })
    if (turn === 1) {
      const head: SystemMessage = {
        id: MessageId(this.id()),
        role: 'system',
        content: [],
        source: { kind: 'system-prompt' },
      }
      this.add({
        type: 'system/message',
        data: { turn, step, message: head },
        surfaceOp: 'append',
      })
    }
    this.add({
      type: 'user/message',
      data: this.userMessage(user, turn === 1),
      surfaceOp: 'append',
    })
    if (reply === undefined) {
      this.closeTurn(turn, step, failure(
        'DEEPSEEK_EXPORT_NO_REPLY',
        'The export contains no reply to this message.',
      ))
      return
    }

    const { steps, template } = this.replySteps(reply)
    const excluded = excludedReply(reply, template, steps.length)
    if (excluded !== undefined) {
      this.closeTurn(turn, step, { kind: 'error', error: excluded })
      return
    }

    for (const [position, { content, calls, elapsedMs }] of steps.entries()) {
      if (position > 0) {
        step++
        this.add({ type: 'step/start', data: { turn, step } })
      }
      this.time += elapsedMs
      this.add({
        type: 'assistant/message',
        data: {
          turn,
          step,
          message: assistantMessage(this.id(), [
            ...content,
            ...calls.map(call => call.block),
          ]),
          stream: [],
        },
        surfaceOp: 'append',
      })
      const callSeqs = calls.map(({ block }) => this.add({
        type: 'tool/call',
        data: {
          turn,
          step,
          callId: block.id,
          name: block.name,
          arguments: block.arguments,
        },
      }))
      for (const [callIndex, call] of calls.entries()) {
        this.add({
          type: 'tool/result',
          data: {
            turn,
            step,
            message: toolResult(this.id(), call),
            ...(call.meta === undefined ? {} : { meta: call.meta }),
          },
          surfaceOp: 'append',
          sourceEventSeqs: [callSeqs[callIndex]!],
        })
      }
      if (position < steps.length - 1) {
        this.add({ type: 'step/end', data: { turn, step } })
      }
    }
    this.closeTurn(turn, step, { kind: 'completed' })
  }

  private closeTurn(
    turn: number,
    step: number,
    reason: { kind: 'completed' } | { kind: 'error'; error: LlmFailure },
  ): void {
    this.add({ type: 'step/end', data: { turn, step } })
    this.add({ type: 'turn/end', data: { turn, reason } })
  }

  private id(): string {
    return this.createId()
  }

  private userMessage(message: WebChatRichMessage, firstTurn: boolean): UserMessage {
    const lines: string[] = []
    for (const fragment of message.fragments) {
      if (fragment.type === 'REQUEST') lines.push(fragment.content)
    }
    let text = lines.join('\n')
    if (firstTurn && this.provenancePrefix !== '') {
      text = `${this.provenancePrefix}${text}`
    }
    const content: ContentBlock[] = [{ type: 'text', text }]
    return {
      id: MessageId(this.id()),
      role: 'user',
      content,
      source: { kind: 'user' },
    }
  }

  private replySteps(
    reply: WebChatRichMessage,
  ): { steps: ReplyStep[]; template: string | undefined } {
    const steps: ReplyStep[] = []
    let template: string | undefined
    let current = emptyStep()
    const pushStep = (): void => {
      if (current.content.length === 0 && current.calls.length === 0) return
      steps.push(current)
      current = emptyStep()
    }
    const appendContent = (block: ContentBlock): void => {
      if (current.calls.length > 0) pushStep()
      current.content.push(block)
    }
    const appendCall = (call: PendingCall, stage: number | null): void => {
      if (stage !== null) {
        if (current.stage !== null && stage !== current.stage) pushStep()
        current.stage = stage
      }
      current.calls.push(call)
    }

    for (const fragment of reply.fragments) {
      switch (fragment.type) {
        case 'THINK':
          if (fragment.content.length > 0) {
            appendContent({ type: 'reasoning', text: fragment.content })
          }
          current.elapsedMs += Math.round((fragment.elapsed_secs ?? 0) * 1000)
          break
        case 'RESPONSE':
          if (fragment.content.length > 0) {
            appendContent({ type: 'text', text: fragment.content })
          }
          break
        case 'TOOL_SEARCH': {
          if (fragment.status === 'WIP') break
          const call = searchCall(this.id(), fragment)
          if (call !== undefined) appendCall(call, fragment.stage_id ?? null)
          break
        }
        case 'TOOL_OPEN': {
          const url = nonEmpty(fragment.url)
          if (fragment.status === 'WIP' || url === undefined) break
          appendCall(openCall(this.id(), fragment, url), fragment.stage_id ?? null)
          break
        }
        case 'READ_LINK': {
          const text = linkLines(fragment.results)
          if (text !== undefined) appendContent({ type: 'text', text })
          break
        }
        case 'TEMPLATE_RESPONSE':
          template ??= fragment.content
          break
        case 'REQUEST':
          break
        default: {
          const _exhaustive: never = fragment
          throw new WebChatConvertError(`unexpected fragment ${String(_exhaustive)}`)
        }
      }
    }
    pushStep()
    return { steps, template }
  }
}

function emptyStep(): ReplyStep {
  return { content: [], calls: [], elapsedMs: 0, stage: null }
}

function excludedReply(
  reply: WebChatRichMessage,
  template: string | undefined,
  stepCount: number,
): LlmFailure | undefined {
  if (template !== undefined) {
    return { code: 'DEEPSEEK_EXPORT_TEMPLATE_RESPONSE', message: template }
  }
  if (reply.status !== 'FINISHED') {
    return {
      code: UNFINISHED_STATUS_CODES.get(reply.status) ?? 'DEEPSEEK_EXPORT_UNFINISHED_REPLY',
      message:
        `The original reply ended with status ${JSON.stringify(reply.status)} and is excluded from the model context.`,
    }
  }
  return stepCount === 0
    ? {
      code: 'DEEPSEEK_EXPORT_EMPTY_REPLY',
      message: 'The original reply has no importable content.',
    }
    : undefined
}

function failure(code: string, message: string): { kind: 'error'; error: LlmFailure } {
  return { kind: 'error', error: { code, message } }
}

function linkLines(
  results: Extract<WebChatFragment, { type: 'READ_LINK' }>['results'],
): string | undefined {
  const lines: string[] = []
  for (const result of results) {
    const url = nonEmpty(result.url)
    const title = nonEmpty(result.title)
    if (url !== undefined) lines.push(`[${title ?? url}](${url})`)
    else if (title !== undefined) lines.push(title)
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

function assistantMessage(id: string, content: ContentBlock[]): AssistantMessage {
  return {
    id: MessageId(id),
    role: 'assistant',
    content,
    source: { kind: 'model', ...WEB_CHAT_IMPORTED_MODEL_SOURCE },
  }
}

function toolResult(id: string, call: PendingCall): ToolResultMessage {
  return {
    id: MessageId(id),
    role: 'tool',
    content: call.result,
    isError: call.isError,
    source: { kind: 'tool', callId: call.block.id },
    toolCallId: call.block.id,
  }
}

function searchCall(
  id: string,
  fragment: Extract<WebChatFragment, { type: 'TOOL_SEARCH' }>,
): PendingCall | undefined {
  const queries = fragment.queries.filter(query => query.trim().length > 0)
  const block: ToolCallBlock = {
    type: 'tool-call',
    id: ToolCallId(id),
    name: 'web_search',
    arguments: JSON.stringify({ queries }),
  }
  if (fragment.status === 'FAILED') {
    return {
      block,
      result: [{ type: 'text', text: 'Error: the export records this search as failed.' }],
      isError: true,
    }
  }
  if (queries.length === 0) return undefined
  const result: WebSearchResult = {
    sources: fragment.results.map(source => {
      const title = nonEmpty(source.title)
      const snippet = nonEmpty(source.snippet)
      const publishedAt = nonEmpty(source.published_at)
      return {
        url: source.url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      }
    }),
    truncated: false,
  }
  return {
    block,
    result: [{ type: 'text', text: formatSearchOutput(result) }],
    isError: false,
    meta: searchMetaFromValue(result),
  }
}

function openCall(
  id: string,
  fragment: Extract<WebChatFragment, { type: 'TOOL_OPEN' }>,
  url: string,
): PendingCall {
  const block: ToolCallBlock = {
    type: 'tool-call',
    id: ToolCallId(id),
    name: 'web_fetch',
    arguments: JSON.stringify({ url }),
  }
  if (fragment.status !== 'FINISHED') {
    return {
      block,
      result: [{ type: 'text', text: 'Error: the page could not be opened.' }],
      isError: true,
    }
  }
  const title = nonEmpty(fragment.title)
  const notice = 'The page content is not included in the DeepSeek chat export.'
  const value: WebFetchResult = {
    url,
    statusCode: 200,
    truncated: false,
    body: {
      kind: 'text',
      content: title === undefined ? notice : `${title}\n\n${notice}`,
    },
  }
  return {
    block,
    result: [{ type: 'text', text: formatFetchOutput(value, FETCH_OUTPUT_CHARS) }],
    isError: false,
    meta: fetchMetaFromValue(value, FETCH_OUTPUT_CHARS),
  }
}
