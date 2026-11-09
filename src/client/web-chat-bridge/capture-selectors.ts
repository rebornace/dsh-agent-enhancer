/**
 * Production selectors for chat.deepseek.com rendered capture.
 * Profiles are tried in order until one yields non-empty turns.
 */

export type WebChatCaptureRoleSpec =
  | { readonly kind: 'attr', readonly roleAttr: string }
  | {
    readonly kind: 'ancestor'
    readonly userAncestor: string
    readonly assistantAncestor: string
  }

export interface WebChatCaptureSelectorProfile {
  /** Stable id for logs/tests. */
  readonly id: string
  /**
   * Human-readable provenance (repo, doc, or public frontend note) + audit date.
   * @example FrostLeafKEE/dsh-chat-bridge docs/PAGE-CAPTURE.md (2026-10-01)
   */
  readonly source: string
  readonly turn: string
  readonly role: WebChatCaptureRoleSpec
  /** Fallback when role-specific text selectors miss. */
  readonly textSelector?: string
  readonly userTextSelector?: string
  readonly assistantTextSelector?: string
  readonly title?: string
}

/** @deprecated Prefer {@link DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES} in capture. */
export interface WebChatCaptureSelectors {
  readonly turn: string
  readonly roleAttr: string
  readonly title?: string
}

/**
 * Ordered fallbacks (newest official DOM first).
 *
 * 1. FrostLeafKEE/dsh-chat-bridge `docs/PAGE-CAPTURE.md` + `deepseek-page-reader.ts`
 *    (public bundle main.6fca03582d.js, 2026-10-01): rows `.ds-message`, user/assistant
 *    wrappers `._9663006` / `._4f9bf79`, body selectors as documented.
 * 2. Community exporter / Web2MD notes (2025–2026): `data-role` on message nodes.
 * 3. Legacy ChatGPT-style author attribute (Harmony / older mirrors).
 */
export const DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES: readonly WebChatCaptureSelectorProfile[] = [
  {
    id: 'deepseek-dom-2026-10-01',
    source: 'FrostLeafKEE/dsh-chat-bridge PAGE-CAPTURE.md + deepseek-page-reader.ts (fe-static main.6fca03582d.js, 2026-10-01)',
    turn: '.ds-message',
    role: {
      kind: 'ancestor',
      userAncestor: '._9663006',
      assistantAncestor: '._4f9bf79',
    },
    userTextSelector: '.ds-collapsible-text > div > span',
    assistantTextSelector: '.ds-assistant-message-main-content',
    title: undefined,
  },
  {
    id: 'data-role-messages',
    source: 'web2md.org DeepSeek export guide + ypyf/deepseek-chat-exporter (data-role user|assistant, 2026-11-09 audit)',
    turn: '[data-role="user"], [data-role="assistant"]',
    role: { kind: 'attr', roleAttr: 'data-role' },
  },
  {
    id: 'message-author-role',
    source: 'Community Chat-UI mirror (data-message-author-role on turn root, unverified build — fallback only)',
    turn: '[data-message-author-role]',
    role: { kind: 'attr', roleAttr: 'data-message-author-role' },
  },
] as const

/**
 * First profile only — for callers that need a single {@link WebChatCaptureSelectors} shape.
 * Capture tries {@link DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES} by default.
 */
const PRIMARY_CAPTURE_PROFILE = DEEPSEEK_WEB_CHAT_CAPTURE_SELECTOR_PROFILES[0]!

export const DEEPSEEK_WEB_CHAT_CAPTURE_SELECTORS: WebChatCaptureSelectors = {
  turn: PRIMARY_CAPTURE_PROFILE.turn,
  roleAttr: 'data-role',
}

export function legacySelectorsToProfile(
  selectors: WebChatCaptureSelectors,
): WebChatCaptureSelectorProfile {
  return {
    id: 'legacy-inline',
    source: 'caller-supplied WebChatCaptureSelectors',
    turn: selectors.turn,
    role: { kind: 'attr', roleAttr: selectors.roleAttr },
    title: selectors.title,
  }
}
