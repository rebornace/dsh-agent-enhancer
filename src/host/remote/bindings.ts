import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createCode } from './types.ts'

export type RemoteChannel = 'weixin'

export interface ChatBinding {
  readonly chatId: string
  readonly channel: RemoteChannel
  readonly boundAt: number
}

interface FileShape {
  readonly version: 1
  readonly chats: Record<string, { readonly channel: RemoteChannel; readonly boundAt: number }>
}

export interface BindingStoreOptions {
  /** Null keeps everything in memory (tests, or a host without plugin-data). */
  readonly filePath: string | null
  readonly now?: () => number
  /** Injectable code generator; defaults to 6 digits, which is what people type. */
  readonly code?: () => string
  readonly codeTtlMs?: number
}

const DEFAULT_CODE_TTL_MS = 10 * 60_000
const FILE_VERSION = 1

function numericCode(): string {
  return String(100_000 + Math.floor(Math.random() * 900_000))
}

/**
 * Chat bindings plus the short-lived pairing codes.
 *
 * Only the chat rows are written to disk. Pairing codes are one-shot and live
 * in memory: a code that survives a restart is a code an attacker can wait
 * for. The file holds no tokens and no session handles.
 */
export class BindingStore {
  private readonly chats = new Map<string, ChatBinding>()
  private readonly codes = new Map<string, number>()
  private readonly now: () => number
  private readonly code: () => string
  private readonly codeTtlMs: number

  constructor(private readonly options: BindingStoreOptions) {
    this.now = options.now ?? Date.now
    this.code = options.code ?? numericCode
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS
    this.load()
  }

  isBound(chatId: string): boolean {
    return this.chats.has(chatId)
  }

  binding(chatId: string): ChatBinding | undefined {
    return this.chats.get(chatId)
  }

  list(): readonly ChatBinding[] {
    return [...this.chats.values()]
  }

  bind(chatId: string, channel: RemoteChannel, at = this.now()): ChatBinding {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    const binding: ChatBinding = { chatId, channel, boundAt: at }
    this.chats.set(chatId, binding)
    this.save()
    return binding
  }

  unbind(chatId: string): boolean {
    const removed = this.chats.delete(chatId)
    if (removed) this.save()
    return removed
  }

  unbindAll(): void {
    if (this.chats.size === 0) return
    this.chats.clear()
    this.save()
  }

  /** Issue a one-shot pairing code. Codes are unique among live ones. */
  issueCode(ttlMs = this.codeTtlMs): { code: string; expiresAt: number } {
    this.pruneCodes()
    let code = this.code()
    for (let attempt = 0; this.codes.has(code) && attempt < 20; attempt += 1) code = this.code()
    const expiresAt = this.now() + ttlMs
    this.codes.set(code, expiresAt)
    return { code, expiresAt }
  }

  /** One-shot redemption; expired or unknown codes fail. */
  redeem(code: string, chatId: string, channel: RemoteChannel, at = this.now()): boolean {
    this.pruneCodes(at)
    const expiresAt = this.codes.get(code)
    if (expiresAt === undefined) return false
    this.codes.delete(code)
    this.bind(chatId, channel, at)
    return true
  }

  /** Drop expired pairing codes and return how many were removed. */
  pruneCodes(at = this.now()): number {
    let removed = 0
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt > at) continue
      this.codes.delete(code)
      removed += 1
    }
    return removed
  }

  private load(): void {
    const path = this.options.filePath
    if (path === null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    const shape = parsed as Partial<FileShape>
    if (shape.version !== FILE_VERSION || shape.chats === null || typeof shape.chats !== 'object') return
    for (const [chatId, value] of Object.entries(shape.chats)) {
      if (value === null || typeof value !== 'object') continue
      const channel = (value as { channel?: unknown }).channel
      const boundAt = (value as { boundAt?: unknown }).boundAt
      if (channel !== 'weixin') continue
      this.chats.set(chatId, { chatId, channel, boundAt: typeof boundAt === 'number' ? boundAt : 0 })
    }
  }

  private save(): void {
    const path = this.options.filePath
    if (path === null) return
    const shape: FileShape = {
      version: FILE_VERSION,
      chats: Object.fromEntries([...this.chats].map(([chatId, binding]) => [
        chatId,
        { channel: binding.channel, boundAt: binding.boundAt },
      ])),
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(shape, null, 2))
      renameSync(tmp, path)
    } catch {
      // Persistence is best effort: losing a binding file must not break the
      // running adapter, and the in-memory rows stay usable for this session.
    }
  }
}
