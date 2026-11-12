import { WEB_CHAT_MAX_MESSAGES, WEB_CHAT_MAX_TEXT_BYTES } from '../../host/web-chat-bridge/limits.ts'
import type { WebChatRole, WebChatTranscript, WebChatTurn } from '../../host/web-chat-bridge/types.ts'
import {
  DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES,
  legacySelectorsToProfile,
  type WebChatCaptureSelectorProfile,
  type WebChatCaptureSelectors,
} from './capture-selectors.ts'
import { domToMarkdown, preserveVisibleText } from './dom-to-markdown.ts'

export interface CaptureFromDocumentOptions {
  readonly url: string
  /** Single profile (tests / overrides). */
  readonly selectors?: WebChatCaptureSelectors
  /** Ordered profiles; defaults to {@link DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES}. */
  readonly profiles?: readonly WebChatCaptureSelectorProfile[]
  readonly isGenerating?: () => boolean
  readonly hasUnsentDraft?: () => boolean
  readonly now?: () => string
}

const CHAT_SESSION_ID = /\/s\/([^/?#]+)/i

function normalizeRole(raw: string | null): WebChatRole | null {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  if (key === 'user' || key === 'human') return 'user'
  if (key === 'assistant' || key === 'model' || key === 'ai') return 'assistant'
  return null
}

/** Titles / short labels: single-line is fine. */
function elementLabel(el: Element): string {
  const withInner = el as HTMLElement
  const raw = typeof withInner.innerText === 'string' && withInner.innerText.length > 0
    ? withInner.innerText
    : el.textContent ?? ''
  return preserveVisibleText(raw).replace(/\s+/g, ' ').trim()
}

/**
 * Message bodies: prefer HTML→Markdown so imported chat keeps fences / lists.
 * Fall back to newline-preserving visible text when the subtree is plain.
 */
function elementMessageText(el: Element): string {
  const fromDom = domToMarkdown(el)
  if (fromDom !== '') return fromDom
  const withInner = el as HTMLElement
  const raw = typeof withInner.innerText === 'string' && withInner.innerText.length > 0
    ? withInner.innerText
    : el.textContent ?? ''
  return preserveVisibleText(raw)
}

function readTitle(
  doc: Document,
  profiles: readonly WebChatCaptureSelectorProfile[],
): string {
  for (const profile of profiles) {
    if (!profile.title) continue
    const node = doc.querySelector(profile.title)
    const text = node ? elementLabel(node) : ''
    if (text) return text
  }
  const docTitle = doc.title?.trim()
  if (docTitle) return docTitle
  return 'Web chat'
}

/** `/a/chat/s/{id}` (and `/s/{id}`) session id used by history_messages. */
export function chatSessionIdFromUrl(url: string): string | undefined {
  const match = url.match(CHAT_SESSION_ID)
  return match?.[1]
}

function assertTurnLimits(turns: readonly WebChatTurn[]): void {
  if (turns.length === 0) {
    throw new Error('capture-empty: no messages found in page')
  }
  if (turns.length > WEB_CHAT_MAX_MESSAGES) {
    throw new Error(`capture-too-large: exceeds message limit (${WEB_CHAT_MAX_MESSAGES})`)
  }
  let bytes = 0
  for (const turn of turns) {
    bytes += new TextEncoder().encode(turn.text).length
    if (bytes > WEB_CHAT_MAX_TEXT_BYTES) {
      throw new Error(`capture-too-large: exceeds ${WEB_CHAT_MAX_TEXT_BYTES} byte limit`)
    }
  }
}

function assertProfile(profile: WebChatCaptureSelectorProfile): void {
  if (!profile.turn.trim()) {
    throw new Error('capture-selectors: turn selector must not be empty')
  }
  if (profile.role.kind === 'attr' && !profile.role.roleAttr.trim()) {
    throw new Error('capture-selectors: role attribute name must not be empty')
  }
}

function roleFromProfile(el: Element, profile: WebChatCaptureSelectorProfile): WebChatRole | null {
  if (profile.role.kind === 'attr') {
    return normalizeRole(el.getAttribute(profile.role.roleAttr))
  }
  const user = el.closest(profile.role.userAncestor) !== null
  const assistant = el.closest(profile.role.assistantAncestor) !== null
  if (user === assistant) return null
  if (user) return 'user'
  if (assistant) return 'assistant'
  return null
}

function textFromProfile(el: Element, role: WebChatRole, profile: WebChatCaptureSelectorProfile): string {
  const specific = role === 'user'
    ? profile.userTextSelector
    : profile.assistantTextSelector
  const selector = specific ?? profile.textSelector
  if (selector) {
    const nodes = el.querySelectorAll(selector)
    if (nodes.length === 1) return elementMessageText(nodes[0]!)
    if (nodes.length > 1) {
      return Array.from(nodes, node => elementMessageText(node)).filter(Boolean).join('\n\n')
    }
  }
  return elementMessageText(el)
}

function collectTurnsFromProfile(
  doc: Document,
  profile: WebChatCaptureSelectorProfile,
): WebChatTurn[] {
  assertProfile(profile)
  const nodes = doc.querySelectorAll(profile.turn)
  const turns: WebChatTurn[] = []
  for (const el of nodes) {
    const role = roleFromProfile(el, profile)
    if (!role) continue
    const text = textFromProfile(el, role, profile)
    if (!text) continue
    turns.push({ role, text })
  }
  return turns
}

function resolveProfiles(
  options: CaptureFromDocumentOptions,
): readonly WebChatCaptureSelectorProfile[] {
  if (options.profiles !== undefined && options.profiles.length > 0) {
    return options.profiles
  }
  if (options.selectors !== undefined) {
    return [legacySelectorsToProfile(options.selectors)]
  }
  return DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES
}

function isRetryableProfileError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /capture-empty|no messages found/i.test(error.message)
}

export function captureFromDocument(
  doc: Document,
  options: CaptureFromDocumentOptions,
): WebChatTranscript {
  if (options.isGenerating?.()) {
    throw new Error('capture-generating: assistant response still in progress')
  }
  if (options.hasUnsentDraft?.()) {
    throw new Error('capture-unsent-draft: composer has unsent text')
  }

  const profiles = resolveProfiles(options)
  let lastError: Error | null = null

  for (const profile of profiles) {
    try {
      const turns = collectTurnsFromProfile(doc, profile)
      assertTurnLimits(turns)
      const capturedAt = options.now?.() ?? new Date().toISOString()
      const chatSessionId = chatSessionIdFromUrl(options.url)
      return {
        title: readTitle(doc, profiles),
        turns,
        partial: true,
        source: {
          kind: 'rendered-capture',
          url: options.url,
          ...(chatSessionId !== undefined ? { chatSessionId } : {}),
          capturedAt,
        },
      }
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error))
      lastError = wrapped
      if (!isRetryableProfileError(wrapped)) throw wrapped
    }
  }

  throw lastError ?? new Error('capture-structure: unable to match known message DOM')
}
