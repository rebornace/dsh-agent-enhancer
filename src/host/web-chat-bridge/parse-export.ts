import { inflateRawSync } from 'node:zlib'
import {
  WEB_CHAT_MAX_EXPORT_CONVERSATIONS,
  WEB_CHAT_MAX_MESSAGES,
  WEB_CHAT_MAX_TEXT_BYTES,
} from './limits.ts'
import type {
  AnalyzeWebChatExportResult,
  ParseWebChatExportInput,
  WebChatExportCatalogItem,
  WebChatRole,
  WebChatTranscript,
  WebChatTurn,
} from './types.ts'

const SECTION_HEADER = /^##\s*(User|Assistant|用户|助手)\s*$/gim
const MARKDOWN_CHAT_SPLIT = /^#\s+(.+)$/gm

function assertPayloadSize(bytes: Buffer): void {
  if (bytes.length > WEB_CHAT_MAX_TEXT_BYTES) {
    throw new Error(`Export too large: exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
  }
}

function assertTurnCount(turns: readonly WebChatTurn[]): void {
  if (turns.length === 0) {
    throw new Error('No messages found in export')
  }
  if (turns.length > WEB_CHAT_MAX_MESSAGES) {
    throw new Error(`Exceeds message limit (${WEB_CHAT_MAX_MESSAGES})`)
  }
}

function normalizeRole(raw: string): WebChatRole | null {
  const key = raw.trim().toLowerCase()
  if (key === 'user' || key === '用户') return 'user'
  if (key === 'assistant' || key === '助手') return 'assistant'
  return null
}

function extractTitleFromMarkdown(text: string): string {
  const match = text.match(/^#\s+(.+)$/m)
  if (match?.[1]) return match[1].trim()
  const firstLine = text.split(/\r?\n/).find((line) => line.trim() !== '')
  return firstLine?.trim() ?? 'Imported chat'
}

function parseMarkdownTurns(text: string): WebChatTurn[] {
  const turns: WebChatTurn[] = []
  const matches = [...text.matchAll(SECTION_HEADER)]
  if (matches.length === 0) return turns

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const role = normalizeRole(match[1]!)
    if (!role) continue
    const start = match.index! + match[0].length
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length
    const body = text.slice(start, end).trim()
    if (body) turns.push({ role, text: body })
  }
  return turns
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text: unknown }).text === 'string') {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  return ''
}

function normalizeJsonRole(raw: unknown): WebChatRole | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  if (key === 'user' || key === 'human') return 'user'
  if (key === 'assistant' || key === 'model' || key === 'ai') return 'assistant'
  return null
}

function turnsFromMessageRows(rows: readonly unknown[]): WebChatTurn[] {
  const turns: WebChatTurn[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const item = row as Record<string, unknown>
    const role = normalizeJsonRole(item.role ?? item.author ?? item.speaker)
    if (!role) continue
    const text = messageText(item.content ?? item.text ?? item.message)
    if (text) turns.push({ role, text })
  }
  return turns
}

function titleOfObject(obj: Record<string, unknown>, fallback: string): string {
  if (typeof obj.title === 'string' && obj.title.trim()) return obj.title.trim()
  if (typeof obj.name === 'string' && obj.name.trim()) return obj.name.trim()
  if (typeof obj.chat_title === 'string' && obj.chat_title.trim()) return obj.chat_title.trim()
  return fallback
}

function conversationFromObject(
  value: unknown,
  fallbackTitle: string,
): { title: string, turns: WebChatTurn[] } | null {
  if (Array.isArray(value)) {
    const turns = turnsFromMessageRows(value)
    return turns.length > 0 ? { title: fallbackTitle, turns } : null
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const title = titleOfObject(obj, fallbackTitle)
  let rows: unknown[] = []
  if (Array.isArray(obj.messages)) rows = obj.messages
  else if (Array.isArray(obj.conversation)) rows = obj.conversation
  else if (Array.isArray(obj.turns)) rows = obj.turns
  else if (Array.isArray(obj.chat_messages)) rows = obj.chat_messages
  const turns = turnsFromMessageRows(rows)
  return turns.length > 0 ? { title, turns } : null
}

/** Expand a JSON value into zero or more conversations (array / chats[] / single). */
function conversationsFromJsonValue(
  value: unknown,
  fallbackTitle: string,
): Array<{ title: string, turns: WebChatTurn[] }> {
  if (Array.isArray(value)) {
    const asMessages = turnsFromMessageRows(value)
    if (asMessages.length > 0 && value.every(row => {
      if (!row || typeof row !== 'object') return false
      const item = row as Record<string, unknown>
      return normalizeJsonRole(item.role ?? item.author ?? item.speaker) !== null
    })) {
      return [{ title: fallbackTitle, turns: asMessages }]
    }
    const out: Array<{ title: string, turns: WebChatTurn[] }> = []
    for (let i = 0; i < value.length; i++) {
      const parsed = conversationFromObject(value[i], `${fallbackTitle} ${i + 1}`)
      if (parsed) out.push(parsed)
    }
    return out
  }

  if (!value || typeof value !== 'object') return []
  const obj = value as Record<string, unknown>
  const listKeys = ['chats', 'conversations', 'chat_sessions', 'sessions', 'history'] as const
  for (const key of listKeys) {
    const list = obj[key]
    if (!Array.isArray(list) || list.length === 0) continue
    const out: Array<{ title: string, turns: WebChatTurn[] }> = []
    for (let i = 0; i < list.length; i++) {
      const parsed = conversationFromObject(list[i], `${fallbackTitle} ${i + 1}`)
      if (parsed) out.push(parsed)
    }
    if (out.length > 0) return out
  }

  const single = conversationFromObject(obj, fallbackTitle)
  return single ? [single] : []
}

function splitMarkdownConversations(text: string): Array<{ title: string, body: string }> {
  const matches = [...text.matchAll(MARKDOWN_CHAT_SPLIT)]
  if (matches.length <= 1) {
    return [{ title: extractTitleFromMarkdown(text), body: text }]
  }
  const out: Array<{ title: string, body: string }> = []
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!
    const title = match[1]!.trim() || `Chat ${i + 1}`
    const start = match.index!
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : text.length
    const body = text.slice(start, end).trim()
    if (body) out.push({ title, body })
  }
  return out
}

function parseTextConversations(
  text: string,
  filename: string,
): Array<{ title: string, turns: WebChatTurn[] }> {
  const chunks = splitMarkdownConversations(text)
  const out: Array<{ title: string, turns: WebChatTurn[] }> = []
  for (const chunk of chunks) {
    const turns = parseMarkdownTurns(chunk.body)
    if (turns.length > 0) {
      out.push({ title: chunk.title, turns })
      continue
    }
  }
  if (out.length > 0) return out

  const trimmed = text.trim()
  if (trimmed && filename.toLowerCase().endsWith('.txt')) {
    return [{ title: extractTitleFromMarkdown(text), turns: [{ role: 'user', text: trimmed }] }]
  }
  return []
}

function isZipArchive(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

interface ZipEntryDescriptor {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly dataOffset: number
}

function zipEntryPriority(name: string): number {
  const lower = name.toLowerCase()
  if (lower.endsWith('.md')) return 0
  if (lower.endsWith('.json')) return 1
  if (lower.endsWith('.txt')) return 2
  return 9
}

function decompressZipEntry(method: number, compressed: Buffer, uncompressedSize: number): Buffer {
  if (uncompressedSize > WEB_CHAT_MAX_TEXT_BYTES) {
    throw new Error(`Export too large: exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
  }
  if (method === 0) {
    if (compressed.length > WEB_CHAT_MAX_TEXT_BYTES) {
      throw new Error(`Export too large: exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
    }
    return compressed
  }
  if (method === 8) {
    return inflateRawSync(compressed, { maxOutputLength: WEB_CHAT_MAX_TEXT_BYTES + 1 })
  }
  throw new Error('unrecognized-export: unsupported zip compression')
}

function listZipEntryDescriptors(bytes: Buffer): ZipEntryDescriptor[] {
  const entries: ZipEntryDescriptor[] = []
  let offset = 0

  while (offset + 30 <= bytes.length) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break

    const method = bytes.readUInt16LE(offset + 8)
    const compressedSize = bytes.readUInt32LE(offset + 18)
    const uncompressedSize = bytes.readUInt32LE(offset + 22)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    const headerSize = 30 + nameLength + extraLength
    const nameStart = offset + 30
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.length) break

    const name = bytes.toString('utf8', nameStart, nameEnd)
    const dataStart = offset + headerSize
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) break

    if (method === 0 || method === 8) {
      entries.push({
        name,
        method,
        compressedSize,
        uncompressedSize,
        dataOffset: dataStart,
      })
    }

    offset = dataEnd
  }

  return entries
}

function readZipEntryPayload(bytes: Buffer, descriptor: ZipEntryDescriptor): Buffer {
  const compressed = bytes.subarray(
    descriptor.dataOffset,
    descriptor.dataOffset + descriptor.compressedSize,
  )
  return decompressZipEntry(descriptor.method, compressed, descriptor.uncompressedSize)
}

function buildTranscript(
  filename: string,
  title: string,
  turns: readonly WebChatTurn[],
): WebChatTranscript {
  assertTurnCount(turns)
  return {
    title: title || 'Imported chat',
    turns,
    partial: false,
    source: {
      kind: 'official-export',
      capturedAt: new Date().toISOString(),
      filename,
    },
  }
}

function previewOfTurns(turns: readonly WebChatTurn[]): string {
  const firstUser = turns.find(turn => turn.role === 'user') ?? turns[0]
  if (firstUser === undefined) return ''
  const text = firstUser.text.trim()
  return text.length <= 160 ? text : `${text.slice(0, 159)}…`
}

function toCatalogItems(
  filename: string,
  conversations: ReadonlyArray<{ title: string, turns: WebChatTurn[] }>,
): WebChatExportCatalogItem[] {
  const items: WebChatExportCatalogItem[] = []
  for (let i = 0; i < conversations.length && items.length < WEB_CHAT_MAX_EXPORT_CONVERSATIONS; i++) {
    const conversation = conversations[i]!
    try {
      const transcript = buildTranscript(filename, conversation.title, conversation.turns)
      items.push({
        id: `chat-${i + 1}`,
        title: transcript.title,
        turnCount: transcript.turns.length,
        preview: previewOfTurns(transcript.turns),
        transcript,
      })
    } catch {
      // Skip over-limit / empty conversations; keep scanning others.
    }
  }
  return items
}

function conversationsFromBytes(
  filename: string,
  bytes: Buffer,
): Array<{ title: string, turns: WebChatTurn[] }> {
  const lowerName = filename.toLowerCase()

  if (isZipArchive(bytes) || lowerName.endsWith('.zip')) {
    const descriptors = listZipEntryDescriptors(bytes)
      .filter(entry => !entry.name.endsWith('/') && zipEntryPriority(entry.name) < 9)
      .sort((a, b) => zipEntryPriority(a.name) - zipEntryPriority(b.name) || a.name.localeCompare(b.name))
    if (descriptors.length === 0) {
      throw new Error('unrecognized-export: no parseable file in zip')
    }

    // Prefer one aggregate JSON that already lists many chats; otherwise one entry = one chat.
    const jsonEntries = descriptors.filter(entry => entry.name.toLowerCase().endsWith('.json'))
    for (const entry of jsonEntries) {
      const payload = readZipEntryPayload(bytes, entry)
      assertPayloadSize(payload)
      const nestedName = entry.name.split(/[/\\]/).pop() ?? entry.name
      let parsed: unknown
      try {
        parsed = JSON.parse(payload.toString('utf8')) as unknown
      } catch {
        continue
      }
      const conversations = conversationsFromJsonValue(parsed, extractTitleFromMarkdown(nestedName))
      if (conversations.length > 1) return conversations
    }

    const out: Array<{ title: string, turns: WebChatTurn[] }> = []
    for (const entry of descriptors) {
      if (out.length >= WEB_CHAT_MAX_EXPORT_CONVERSATIONS) break
      try {
        const payload = readZipEntryPayload(bytes, entry)
        assertPayloadSize(payload)
        const nestedName = entry.name.split(/[/\\]/).pop() ?? entry.name
        out.push(...conversationsFromBytes(nestedName, payload))
      } catch {
        // Skip bad entries.
      }
    }
    return out
  }

  if (lowerName.endsWith('.json') || bytes[0] === 0x7b || bytes[0] === 0x5b) {
    const text = bytes.toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('unrecognized-export: invalid json')
    }
    return conversationsFromJsonValue(parsed, extractTitleFromMarkdown(filename))
  }

  if (lowerName.endsWith('.md') || lowerName.endsWith('.txt')) {
    return parseTextConversations(bytes.toString('utf8'), filename)
  }

  throw new Error('unrecognized-export: unsupported file type')
}

/** Analyze an export into selectable conversations (does not import). */
export function analyzeWebChatExport(
  input: ParseWebChatExportInput,
): AnalyzeWebChatExportResult {
  assertPayloadSize(input.bytes)
  const conversations = conversationsFromBytes(input.filename, input.bytes)
  const items = toCatalogItems(input.filename, conversations)
  if (items.length === 0) {
    throw new Error('No messages found in export')
  }
  return {
    items,
    truncated: conversations.length > items.length,
  }
}

/** Backward-compatible single-transcript parse (first conversation). */
export function parseWebChatExport(input: ParseWebChatExportInput): WebChatTranscript {
  const { items } = analyzeWebChatExport(input)
  const transcript = items[0]?.transcript
  if (transcript === undefined) {
    throw new Error('No messages found in export')
  }
  return transcript
}
