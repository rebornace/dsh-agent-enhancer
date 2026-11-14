import {
  extractWebChatShareId,
  webChatHistoryMessagesApiUrl,
  webChatShareContentApiUrl,
} from '../../host/web-chat-bridge/share-link.ts'
import type { GuestWebView } from './guest.tsx'

export type GuestFetchFailureReason =
  | 'off-origin'
  | 'no-guest'
  | 'http'
  | 'biz'
  | 'empty'
  | 'script'
  | 'unknown'

export interface GuestFetchResult {
  readonly ok: true
  readonly json: string
}

export interface GuestFetchFailure {
  readonly ok: false
  readonly reason: GuestFetchFailureReason
  readonly detail?: string
}

/**
 * Same-origin fetch inside the guest.
 * Logged-in endpoints (`history_messages`) need the SPA Bearer token from
 * `localStorage.userToken` — cookies alone are not enough (unlike public share).
 */
async function fetchJsonPayloadFromGuest(
  guest: GuestWebView | null,
  apiUrl: string,
): Promise<GuestFetchResult | GuestFetchFailure> {
  if (guest === null) return { ok: false, reason: 'no-guest' }
  const script = `
(async function () {
  var origin = 'https://chat.deepseek.com';
  if (String(location && location.origin || '') !== origin) {
    return { ok: false, reason: 'off-origin' };
  }
  try {
    var headers = {
      accept: 'application/json, text/plain, */*',
      'x-client-platform': 'web',
      'x-client-locale': (navigator.language || 'en_US').replace('-', '_'),
    };
    try {
      var rawToken = localStorage.getItem('userToken');
      if (rawToken) {
        var parsed = JSON.parse(rawToken);
        var value = parsed && typeof parsed.value === 'string' ? parsed.value : '';
        if (value) headers.authorization = 'Bearer ' + value;
      }
    } catch (tokenError) {
      // continue without Authorization; public share may still work
    }
    var response = await fetch(${JSON.stringify(apiUrl)}, {
      method: 'GET',
      credentials: 'include',
      headers: headers,
    });
    if (!response.ok) {
      return { ok: false, reason: 'http', detail: String(response.status) };
    }
    var data = await response.json();
    if (data && typeof data === 'object' && data.code !== 0 && data.code !== undefined) {
      return {
        ok: false,
        reason: 'biz',
        detail: String(data.msg || data.code || 'biz-error'),
      };
    }
    var text = JSON.stringify(data);
    if (!text || text === 'null') return { ok: false, reason: 'empty' };
    return { ok: true, json: text };
  } catch (e) {
    return { ok: false, reason: 'script', detail: String(e && e.message || e) };
  }
})()
`
  try {
    const raw = await guest.executeJavaScript(script, true)
    if (raw === null || typeof raw !== 'object') {
      return { ok: false, reason: 'unknown' }
    }
    if (Reflect.get(raw, 'ok') === true) {
      const json = Reflect.get(raw, 'json')
      if (typeof json === 'string' && json.trim() !== '') {
        return { ok: true, json }
      }
      return { ok: false, reason: 'empty' }
    }
    const reasonRaw = Reflect.get(raw, 'reason')
    const reason: GuestFetchFailureReason = reasonRaw === 'off-origin'
      || reasonRaw === 'http'
      || reasonRaw === 'biz'
      || reasonRaw === 'empty'
      || reasonRaw === 'script'
      ? reasonRaw
      : 'unknown'
    const detail = Reflect.get(raw, 'detail')
    return {
      ok: false,
      reason,
      ...(typeof detail === 'string' && detail.trim() !== '' ? { detail } : {}),
    }
  } catch {
    return { ok: false, reason: 'script' }
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
  const result = await fetchJsonPayloadFromGuest(guest, webChatShareContentApiUrl(shareId))
  return result.ok ? result.json : null
}

/**
 * Logged-in history for the open `/s/{id}` session — same fragment tree as share links.
 * Requires guest Bearer from `userToken`; returns failure detail when auth/API fails.
 */
export async function fetchWebChatHistoryPayloadFromGuest(
  guest: GuestWebView | null,
  chatSessionId: string,
): Promise<GuestFetchResult | GuestFetchFailure> {
  const id = chatSessionId.trim()
  if (id === '') return { ok: false, reason: 'empty' }
  return fetchJsonPayloadFromGuest(guest, webChatHistoryMessagesApiUrl(id))
}
