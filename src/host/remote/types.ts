/** Channel-agnostic model for remote task control. */

export type TaskId = string

/** States a task can be stored in. `offline` is derived from the host connection, never stored. */
export type TaskState = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'stopped'

export type PresentedState = TaskState | 'offline'

export type PendingKind = 'approval' | 'question'

export type Risk = 'write' | 'shell' | 'network' | 'other'

export interface Pending {
  readonly kind: PendingKind
  /** One-shot, chat-unique decision code (4 chars, no ambiguous letters). */
  readonly code: string
  readonly prompt: string
  readonly options?: readonly string[]
  readonly risk?: Risk
  /** Session the pending belongs to. Decisions must match it. */
  readonly sessionId: TaskId
  readonly createdAt: number
  readonly expiresAt: number
}

export interface Task {
  readonly id: TaskId
  /** Session title snapshot; refresh from the host when possible. */
  readonly title: string
  readonly state: TaskState
  readonly lastActivityAt: number
  readonly lastLine?: string
  readonly pending?: Pending
  /** State to return to after a soft pause. */
  readonly resumeTo?: 'running' | 'waiting'
}

/** What a channel can do; the core degrades instead of branching on channel names. */
export interface ChannelCapabilities {
  readonly buttons: boolean
  readonly editMessage: boolean
  readonly threads: boolean
  readonly media: 'none' | 'image' | 'file'
  readonly markdown: boolean
  readonly maxChars: number
  readonly privateOnly: boolean
}

/** Ambiguous characters (0/o, 1/l/i) are excluded so codes survive being read aloud. */
export const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export const CODE_LENGTH = 4
export const DEFAULT_PENDING_TTL_MS = 240_000

export function isCode(value: string): boolean {
  if (value.length !== CODE_LENGTH) return false
  for (const char of value) {
    if (!CODE_ALPHABET.includes(char)) return false
  }
  return true
}

export function createCode(random: (max: number) => number = max => Math.floor(Math.random() * max)): string {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET.charAt(random(CODE_ALPHABET.length))
  }
  return code
}

export interface NewPendingInput {
  readonly kind: PendingKind
  readonly sessionId: TaskId
  readonly prompt: string
  readonly options?: readonly string[]
  readonly risk?: Risk
  readonly code?: string
  readonly ttlMs?: number
}

export function createPending(input: NewPendingInput, now: number): Pending {
  return {
    kind: input.kind,
    code: input.code ?? createCode(),
    prompt: input.prompt,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.risk === undefined ? {} : { risk: input.risk }),
    sessionId: input.sessionId,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_PENDING_TTL_MS),
  }
}

export function isExpired(pending: Pending, now: number): boolean {
  return now >= pending.expiresAt
}
