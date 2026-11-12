import {
  extractWebChatShareId,
  webChatHistoryMessagesApiUrl,
  webChatShareContentApiUrl,
} from '../../host/web-chat-bridge/share-link.ts'
import type { GuestWebView } from './guest.tsx'

async function fetchJsonPayloadFromGuest(
  guest: GuestWebView | null,
  apiUrl: string,
): Promise<string | null> {
  if (guest === null) return null
  const script = `
(async function () {
  var origin = 'https://chat.deepseek.com';
  if (String(location && location.origin || '') !== origin) return { ok: false, reason: 'off-origin' };
  try {
    var response = await fetch(${JSON.stringify(apiUrl)}, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*' }
    });
    if (!response.ok) return { ok: false, reason: 'http-' + response.status };
    var data = await response.json();
    return { ok: true, json: JSON.stringify(data) };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
})()
`
  try {
    const raw = await guest.executeJavaScript(script, true)
    if (raw === null || typeof raw !== 'object') return null
    if (Reflect.get(raw, 'ok') !== true) return null
    const json = Reflect.get(raw, 'json')
    return typeof json === 'string' && json.trim() !== '' ? json : null
  } catch {
    return null
  }
}

/**
 * Same-origin fetch inside the guest (avoids Host-side WAF when possible).
 * Returns JSON text for Host `resolveWebChatShareLink({ payloadJson })`.
 */
export async function fetchWebChatSharePayloadFromGuest(
  guest: GuestWebView | null,
  shareUrlOrId: string,
): Promise<string | null> {
  const shareId = extractWebChatShareId(shareUrlOrId)
  if (shareId === null) return null
  return fetchJsonPayloadFromGuest(guest, webChatShareContentApiUrl(shareId))
}

/**
 * Logged-in history for the open `/s/{id}` session — same fragment markdown as share links.
 */
export async function fetchWebChatHistoryPayloadFromGuest(
  guest: GuestWebView | null,
  chatSessionId: string,
): Promise<string | null> {
  const id = chatSessionId.trim()
  if (id === '') return null
  return fetchJsonPayloadFromGuest(guest, webChatHistoryMessagesApiUrl(id))
}
