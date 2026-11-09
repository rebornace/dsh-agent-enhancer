import {
  WEB_CHAT_OFFICIAL_ORIGIN,
  type WebChatLoginSnapshot,
} from '../../host/web-chat-bridge/login-snapshot-types.ts'

/** Desktop `will-attach-webview` only approves guests bootstrapped this way (peer: ui-sidebar-browser). */
export function buildWebChatGuestBootstrapSrc(lease: string): string {
  return `about:blank#${lease}`
}

/**
 * Site-owned “don't show unsafe-environment banner again” flag.
 * Writing `{ value: true, __version }` matches the chat.deepseek.com app-kit envelope
 * (same as clicking the banner’s dismiss control). Peer: dsh-vt-web-chat.
 */
export const WEB_CHAT_UNSAFE_ENV_WARN_KEY = 'closeUnsafeEnvWarn'

/** Caps guest reloads while settling site preferences for one webview session. */
export const WEB_CHAT_PREF_RELOAD_LIMIT = 2

export const WEB_CHAT_PREF_GUARD_KEY = 'agent-enhancer-web-chat:pref-reloads'

export type WebChatGuestPreferencesResult = 'ready' | 'reloading' | 'settled' | 'unavailable' | 'off-origin'

/**
 * Guest script: dismiss the official “使用环境异常” banner via the site’s own
 * localStorage flag, then reload once so the SPA boots without it.
 * Does not change UA / fingerprint — only the site’s remembered dismiss state.
 */
export function buildWebChatGuestPreferencesScript(): string {
  return `
(function () {
  var origin = '${WEB_CHAT_OFFICIAL_ORIGIN}';
  var here = String(location && location.origin || '');
  if (here !== origin) return 'off-origin';
  try {
    var reloads = Number(sessionStorage.getItem('${WEB_CHAT_PREF_GUARD_KEY}') || '0');
    if (reloads >= ${WEB_CHAT_PREF_RELOAD_LIMIT}) return 'settled';
    var read = function (key) {
      try {
        var raw = localStorage.getItem(key);
        if (raw === null) return null;
        var parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : null;
      } catch (e) {
        return null;
      }
    };
    var write = function (key, value) {
      var record = read(key) || {};
      record.value = value;
      if (typeof record.__version !== 'string') record.__version = '0';
      localStorage.setItem(key, JSON.stringify(record));
    };
    var warning = read('${WEB_CHAT_UNSAFE_ENV_WARN_KEY}');
    if (warning === null || warning.value !== true) {
      write('${WEB_CHAT_UNSAFE_ENV_WARN_KEY}', true);
      sessionStorage.setItem('${WEB_CHAT_PREF_GUARD_KEY}', String(reloads + 1));
      location.reload();
      return 'reloading';
    }
    return 'ready';
  } catch (e) {
    return 'unavailable';
  }
})()
`
}

export function webChatGuestPreferencesNeedsWait(result: unknown): boolean {
  return result === 'reloading'
}

/** True when site prefs finished and the guest may be shown (no pending reload). */
export function webChatGuestPreferencesAllowsReveal(result: unknown): boolean {
  return result === 'ready' || result === 'settled' || result === 'unavailable'
}

/**
 * Remove Electron’s UA token. Some community embeds do this so chat.deepseek.com
 * is less likely to open the “使用环境异常” banner. Fingerprints may still detect
 * the guest — keep closeUnsafeEnvWarn as the reliable dismiss path.
 */
export function stripElectronFromUserAgent(ua: string): string {
  return ua
    .replace(/\s*Electron\/[\w.+-]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Hosts `onOpenRequested` may load into the guest.
 * In-webview navigations stay on the webview's own history and are not filtered here.
 * Chat login stays on `chat.deepseek.com` (same-origin XHR). No second account host
 * is allowlisted until a login popup is known to require it.
 */
const WEB_CHAT_GUEST_OPEN_HOSTS = new Set<string>(['chat.deepseek.com'])

/** Popup / external open URLs. Rejects arbitrary http(s), credentials, and other hosts. */
export function isAllowedWebChatGuestOpenUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.port !== '' && url.port !== '443') return false
  return WEB_CHAT_GUEST_OPEN_HOSTS.has(url.hostname)
}

/** Caps guest reloads after writing the login snapshot so the SPA boots with it. */
export const WEB_CHAT_RESTORE_RELOAD_LIMIT = 1

export const WEB_CHAT_RESTORE_GUARD_KEY = 'agent-enhancer-web-chat:restore-reloads'

/**
 * True only when the restore script reports it wrote on the official chat origin.
 * `about:blank` and other early `dom-ready` loads return applied:false and must not stick.
 */
export function webChatLoginRestoreApplied(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  return Reflect.get(result, 'applied') === true
    && Reflect.get(result, 'origin') === WEB_CHAT_OFFICIAL_ORIGIN
}

/** True when restore wrote storage and triggered a reload; wait for the next settle. */
export function webChatLoginRestoreNeedsWait(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  return Reflect.get(result, 'reloading') === true
}

/** Prefix for guest → host clipboard bridge via webview `console-message`. */
export const WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX = '__ae_webchat_clipboard__:'

/**
 * Patch guest `navigator.clipboard` so site “Copy” (e.g. analysis dialog) works
 * inside the Desktop webview when the Clipboard API is denied.
 * Falls back by logging a console marker the host listens for.
 */
export function buildWebChatClipboardBridgeScript(): string {
  return `
(function () {
  var origin = '${WEB_CHAT_OFFICIAL_ORIGIN}';
  if (String(location && location.origin || '') !== origin) return 'off-origin';
  if (window.__aeWebChatClipboardPatched) return 'already';
  window.__aeWebChatClipboardPatched = true;
  var marker = '${WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX}';
  var bridgeWrite = function (text) {
    try { console.log(marker + encodeURIComponent(String(text == null ? '' : text))); } catch (e) {}
    return Promise.resolve();
  };
  try {
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: bridgeWrite, write: function () { return Promise.resolve(); } }
      });
      return 'installed';
    }
    var clip = navigator.clipboard;
    if (typeof clip.writeText === 'function') {
      var origWriteText = clip.writeText.bind(clip);
      clip.writeText = function (text) {
        return origWriteText(text).catch(function () { return bridgeWrite(text); });
      };
    } else {
      clip.writeText = bridgeWrite;
    }
    if (typeof clip.write === 'function') {
      var origWrite = clip.write.bind(clip);
      clip.write = function (items) {
        return origWrite(items).catch(function (err) {
          try {
            if (!items || typeof items[Symbol.iterator] !== 'function') throw err;
            var pending = [];
            for (var item of items) {
              if (item && typeof item.getType === 'function') {
                pending.push(item.getType('text/plain').then(function (blob) {
                  return blob.text();
                }));
              }
            }
            if (pending.length === 0) throw err;
            return Promise.all(pending).then(function (parts) {
              return bridgeWrite(parts.filter(Boolean).join('\\n'));
            });
          } catch (inner) {
            return Promise.reject(err);
          }
        });
      };
    }
    return 'installed';
  } catch (e) {
    return 'unavailable';
  }
})()
`
}

/**
 * Guest script: write localStorage / non-HttpOnly cookies only on the official origin.
 * After a successful write, reload once so the SPA boots with the restored login
 * (Desktop guest partitions are ephemeral across app restarts; disk snapshot alone
 * is not enough if React already started logged-out).
 */
export function buildWebChatLoginRestoreScript(snapshot: WebChatLoginSnapshot): string {
  const payload = JSON.stringify({
    localStorage: snapshot.localStorage,
    cookie: snapshot.cookie,
  })
  return `
(function () {
  var origin = '${WEB_CHAT_OFFICIAL_ORIGIN}';
  var here = String(location && location.origin || '');
  if (here !== origin) return { applied: false, reloading: false, origin: here };
  var input = ${payload};
  var sensitive = /password|passwd|pwd/i;
  var wrote = false;
  if (input.localStorage && typeof input.localStorage === 'object') {
    for (var key in input.localStorage) {
      if (!Object.prototype.hasOwnProperty.call(input.localStorage, key)) continue;
      if (sensitive.test(key)) continue;
      try {
        window.localStorage.setItem(key, input.localStorage[key]);
        wrote = true;
      } catch (e) { /* quota / disabled */ }
    }
  }
  if (typeof input.cookie === 'string' && input.cookie.trim() !== '') {
    var parts = input.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].trim();
      if (pair === '') continue;
      try {
        document.cookie = pair + '; path=/; SameSite=Lax';
        wrote = true;
      } catch (e) { /* non-settable */ }
    }
  }
  if (!wrote) return { applied: false, reloading: false, origin: here };
  try {
    var reloads = Number(sessionStorage.getItem('${WEB_CHAT_RESTORE_GUARD_KEY}') || '0');
    if (reloads < ${WEB_CHAT_RESTORE_RELOAD_LIMIT}) {
      sessionStorage.setItem('${WEB_CHAT_RESTORE_GUARD_KEY}', String(reloads + 1));
      location.reload();
      return { applied: true, reloading: true, origin: here };
    }
  } catch (e) { /* sessionStorage unavailable — keep applied without reload */ }
  return { applied: true, reloading: false, origin: here };
})()
`
}
