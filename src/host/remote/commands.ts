import { CODE_LENGTH, isCode } from './types.ts'

/**
 * The six user-facing words, plus the two forms a question needs.
 *
 * Everything that is not a reserved word is a message for the focused task.
 * The parser never guesses: malformed arguments come back as `invalid` so the
 * caller can answer honestly instead of dropping the user's words.
 */
export type RemoteCommand =
  | { readonly kind: 'tasks' }
  | { readonly kind: 'switch'; readonly number: number }
  | { readonly kind: 'approve'; readonly code?: string }
  | { readonly kind: 'reject'; readonly code?: string }
  | { readonly kind: 'answer'; readonly code?: string; readonly text: string }
  | { readonly kind: 'detail'; readonly number?: number }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'invalid'; readonly reason: string }

type Word =
  | 'tasks'
  | 'switch'
  | 'approve'
  | 'reject'
  | 'answer'
  | 'detail'
  | 'pause'
  | 'resume'

const WORDS: readonly { readonly kind: Word; readonly aliases: readonly string[] }[] = [
  { kind: 'tasks', aliases: ['任务', '任务列表', '列表', 'tasks', 'task', 'list'] },
  { kind: 'switch', aliases: ['切', '切换', 'switch', 'sw'] },
  { kind: 'approve', aliases: ['批准', '同意', 'approve', 'ok'] },
  { kind: 'reject', aliases: ['拒绝', '否决', 'reject', 'deny', 'no'] },
  { kind: 'answer', aliases: ['回答', 'answer'] },
  { kind: 'detail', aliases: ['详情', '查看', 'detail', 'details'] },
  { kind: 'pause', aliases: ['暂停', 'pause'] },
  { kind: 'resume', aliases: ['继续', '恢复', 'resume', 'continue'] },
]

const BY_ALIAS = new Map<string, Word>()
for (const entry of WORDS) {
  for (const alias of entry.aliases) BY_ALIAS.set(alias, entry.kind)
}

const ESCAPES = ['消息', 'message']

function positiveInt(value: string): number | undefined {
  if (!/^[1-9][0-9]{0,3}$/.test(value)) return undefined
  return Number(value)
}

/** Parse one inbound message into a command. Pure; no channel knowledge. */
export function parseCommand(input: string): RemoteCommand {
  const text = input.trim()
  if (text === '') return { kind: 'invalid', reason: 'empty' }

  const lower = text.toLowerCase()
  for (const escape of ESCAPES) {
    if (!lower.startsWith(`${escape} `)) continue
    const payload = text.slice(escape.length).trim()
    if (payload === '') return { kind: 'invalid', reason: 'empty-message' }
    return { kind: 'message', text: payload }
  }

  const space = text.search(/\s/)
  const head = (space === -1 ? text : text.slice(0, space)).toLowerCase()
  const rest = space === -1 ? '' : text.slice(space).trim()
  const kind = BY_ALIAS.get(head)
  if (kind === undefined) return { kind: 'message', text }

  switch (kind) {
    case 'tasks':
      return rest === '' ? { kind } : { kind: 'invalid', reason: 'unexpected-argument' }
    case 'pause':
      return rest === '' ? { kind } : { kind: 'invalid', reason: 'unexpected-argument' }
    case 'resume':
      return rest === '' ? { kind } : { kind: 'invalid', reason: 'unexpected-argument' }
    case 'switch': {
      const number = positiveInt(rest)
      return number === undefined
        ? { kind: 'invalid', reason: 'bad-task-number' }
        : { kind: 'switch', number }
    }
    case 'detail': {
      if (rest === '') return { kind: 'detail' }
      const number = positiveInt(rest)
      return number === undefined
        ? { kind: 'invalid', reason: 'bad-task-number' }
        : { kind: 'detail', number }
    }
    case 'approve':
    case 'reject': {
      if (rest === '') return { kind }
      const code = rest.toLowerCase()
      if (!isCode(code)) return { kind: 'invalid', reason: 'bad-code' }
      return { kind, code }
    }
    case 'answer': {
      if (rest === '') return { kind: 'invalid', reason: 'answer-empty' }
      const withCode = new RegExp(`^([a-z0-9]{${CODE_LENGTH}})\\s+(.+)$`, 'is').exec(rest)
      const code = withCode?.[1]?.toLowerCase()
      if (code !== undefined && isCode(code)) {
        const body = (withCode?.[2] ?? '').trim()
        if (body === '') return { kind: 'invalid', reason: 'answer-empty' }
        return { kind: 'answer', code, text: body }
      }
      return { kind: 'answer', text: rest }
    }
  }
}
