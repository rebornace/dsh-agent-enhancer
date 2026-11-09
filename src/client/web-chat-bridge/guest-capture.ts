import type { GuestWebView } from './guest.tsx'

export interface WebChatGuestBrowseContext {
  readonly url: string
  readonly document: Document | null
  readonly isGenerating: boolean
  readonly hasUnsentDraft: boolean
}

/**
 * Generating / draft gates aligned with FrostLeafKEE/dsh-chat-bridge
 * `src/adapters/deepseek-page-reader.ts` (2026-10-01 public bundle).
 *
 * - Draft: composer textarea with non-whitespace text, excluding textareas inside `.ds-message`.
 * - Generating: stop control `._52c986b` showing spin / known SVG path, or in-row loader `.b4e4476b`.
 *
 * Electron `<webview>` pages live in another process, so `contentDocument` is absent.
 * This script returns the guest HTML plus the same gates; the host parses HTML and
 * hands the document to `captureFromDocument`.
 */
const CAPTURE_DOCUMENT_SCRIPT = `
(function () {
  var drafts = Array.from(document.querySelectorAll('textarea'));
  var unsentDraft = drafts.some(function (input) {
    if (input.closest && input.closest('.ds-message')) return false;
    return (input.value || '').trim() !== '';
  });
  var controls = Array.from(document.querySelectorAll('._52c986b'));
  var generating = controls.some(function (control) {
    if (control.querySelector('[data-icon="spin"]') !== null) return true;
    return Array.from(control.querySelectorAll('path')).some(function (path) {
      return ((path.getAttribute('d') || '').indexOf('M2 4.88') === 0);
    });
  }) || document.querySelector('.ds-message .b4e4476b') !== null;
  var root = document.documentElement;
  return {
    href: String(location.href || ''),
    html: root ? String(root.outerHTML || '') : '',
    generating: generating,
    unsentDraft: unsentDraft
  };
})()
`

interface GuestCapturePayload {
  readonly href: string
  readonly html: string
  readonly generating: boolean
  readonly unsentDraft: boolean
}

function readCapturePayload(raw: unknown): GuestCapturePayload | null {
  if (raw === null || typeof raw !== 'object') return null
  const html = Reflect.get(raw, 'html')
  if (typeof html !== 'string') return null
  const href = Reflect.get(raw, 'href')
  return {
    href: typeof href === 'string' ? href : '',
    html,
    generating: Boolean(Reflect.get(raw, 'generating')),
    unsentDraft: Boolean(Reflect.get(raw, 'unsentDraft')),
  }
}

export function documentFromGuestHtml(html: string): Document | null {
  if (html.trim() === '') return null
  if (typeof DOMParser === 'undefined') return null
  try {
    return new DOMParser().parseFromString(html, 'text/html')
  } catch {
    return null
  }
}

function guestUrl(guest: GuestWebView): string {
  try {
    if (typeof guest.getURL === 'function') return guest.getURL()
  } catch {
    // fall through
  }
  return guest.src ?? ''
}

export async function readWebChatGuestBrowseContext(
  guest: GuestWebView | null,
): Promise<WebChatGuestBrowseContext | null> {
  if (guest === null) return null
  const fallbackUrl = guestUrl(guest)
  try {
    const payload = readCapturePayload(await guest.executeJavaScript(CAPTURE_DOCUMENT_SCRIPT, true))
    if (payload === null) {
      return { url: fallbackUrl, document: null, isGenerating: false, hasUnsentDraft: false }
    }
    return {
      url: payload.href.trim() === '' ? fallbackUrl : payload.href,
      document: documentFromGuestHtml(payload.html),
      isGenerating: payload.generating,
      hasUnsentDraft: payload.unsentDraft,
    }
  } catch {
    return { url: fallbackUrl, document: null, isGenerating: false, hasUnsentDraft: false }
  }
}
