import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { shouldPersistWebChatLoginCapture } from '../../host/web-chat-bridge/login-snapshot-policy.ts'
import {
  WEB_CHAT_OFFICIAL_ORIGIN,
  type WebChatLoginSnapshot,
} from '../../host/web-chat-bridge/login-snapshot-types.ts'
import {
  buildWebChatClipboardBridgeScript,
  buildWebChatGuestBootstrapSrc,
  buildWebChatGuestPreferencesScript,
  buildWebChatLoginRestoreScript,
  isAllowedWebChatGuestOpenUrl,
  stripElectronFromUserAgent,
  WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX,
  webChatGuestPreferencesAllowsReveal,
  webChatGuestPreferencesNeedsWait,
  webChatLoginRestoreApplied,
  webChatLoginRestoreNeedsWait,
} from './guest-policy.ts'
import {
  agentEnhancerLoadWebChatLogin,
  agentEnhancerSaveWebChatLogin,
} from '../remote.ts'
import styles from '../styles.module.css'
import { WEB_CHAT_PANEL_ID } from './kind.ts'

export const WEB_CHAT_BRIDGE_URL = `${WEB_CHAT_OFFICIAL_ORIGIN}/`
export const WEB_CHAT_BRIDGE_STORAGE_ID = WEB_CHAT_PANEL_ID

interface DesktopBrowserReservation {
  readonly lease: string
  readonly partition: string
}

interface DesktopBrowserBridge {
  acquire(identity: string): Promise<DesktopBrowserReservation>
  release(lease: string): Promise<void>
  onOpenRequested?(
    lease: string,
    listener: (detail: { url?: string } | string) => void,
  ): () => void
}

interface DshDesktopBridge {
  readonly protocolVersion?: number
  readonly browser?: DesktopBrowserBridge
}

export type GuestWebView = HTMLWebViewElement & {
  readonly src?: string
  readonly contentDocument?: Document | null
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  clearStorageData?(options?: {
    storages?: string[]
    quotas?: string[]
  }): Promise<void>
  loadURL(url: string): void
  getURL?(): string
  getUserAgent?(): string
  setUserAgent?(userAgent: string): void
}

export type WebChatGuestPhase = 'probing' | 'acquiring' | 'ready' | 'degraded'

export interface UseWebChatBridgeGuestOptions {
  readonly remote: () => { readonly agentEnhancer: object } | undefined
}

export interface WebChatBridgeGuestState {
  readonly phase: WebChatGuestPhase
  readonly errorKey: 'webChatGuestBridgeMissing' | 'webChatGuestLoadFailed' | null
  readonly lease: string | null
  readonly partition: string | null
  /** False until site prefs settle so the unsafe-env banner is not shown to the user. */
  readonly surfaceReady: boolean
  readonly guestRef: RefObject<GuestWebView | null>
  readonly mountGuestHost: (host: HTMLDivElement | null) => void
}

const CAPTURE_SCRIPT = `
(function () {
  var origin = '${WEB_CHAT_OFFICIAL_ORIGIN}';
  if (location.origin !== origin) return null;
  var sensitive = /password|passwd|pwd/i;
  var localStorageOut = {};
  for (var i = 0; i < window.localStorage.length; i++) {
    var key = window.localStorage.key(i);
    if (!key || sensitive.test(key)) continue;
    var value = window.localStorage.getItem(key);
    if (value !== null) localStorageOut[key] = value;
  }
  return {
    origin: origin,
    localStorage: localStorageOut,
    cookie: document.cookie || '',
    savedAt: new Date().toISOString()
  };
})()
`

function desktopBrowserBridge(): DesktopBrowserBridge | null {
  const bridge = (globalThis as typeof globalThis & { dshDesktop?: DshDesktopBridge }).dshDesktop?.browser
  if (bridge === undefined || typeof bridge.acquire !== 'function' || typeof bridge.release !== 'function') {
    return null
  }
  return bridge
}

async function writeHostClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fall through to execCommand / Electron clipboard.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    return
  } catch {
    // Last resort below.
  }
  try {
    const electron = (globalThis as typeof globalThis & {
      require?: (id: string) => { clipboard?: { writeText(value: string): void } }
    }).require?.('electron')
    electron?.clipboard?.writeText(text)
  } catch {
    // Guest already resolved; host write is best-effort.
  }
}

async function captureFromGuest(guest: GuestWebView): Promise<WebChatLoginSnapshot | null> {
  try {
    const raw = await guest.executeJavaScript(CAPTURE_SCRIPT, true)
    if (raw === null || typeof raw !== 'object') return null
    const record = raw as {
      localStorage?: Record<string, string>
      cookie?: string
      savedAt?: string
      origin?: string
    }
    if (record.origin !== WEB_CHAT_OFFICIAL_ORIGIN) return null
    return {
      version: 1,
      origin: WEB_CHAT_OFFICIAL_ORIGIN,
      localStorage: record.localStorage ?? {},
      cookie: typeof record.cookie === 'string' ? record.cookie : '',
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

export function useWebChatBridgeGuest(
  options: UseWebChatBridgeGuestOptions,
): WebChatBridgeGuestState {
  const remoteSource = options.remote
  const guestRef = useRef<GuestWebView | null>(null)
  const leaseRef = useRef<string | null>(null)
  const openDisposeRef = useRef<(() => void) | null>(null)
  const snapshotLoadedRef = useRef(false)
  const pendingSnapshotRef = useRef<WebChatLoginSnapshot | null>(null)
  const baselineSnapshotRef = useRef<WebChatLoginSnapshot | null>(null)
  const [phase, setPhase] = useState<WebChatGuestPhase>('probing')
  const [errorKey, setErrorKey] = useState<WebChatBridgeGuestState['errorKey']>(null)
  const [lease, setLease] = useState<string | null>(null)
  const [partition, setPartition] = useState<string | null>(null)
  const [surfaceReady, setSurfaceReady] = useState(false)
  const [guestNode, setGuestNode] = useState<GuestWebView | null>(null)
  const officialLoadedRef = useRef(false)
  const userAgentPatchedRef = useRef(false)

  const persistSnapshot = useCallback(async () => {
    const guest = guestRef.current
    if (guest === null) return
    const captured = await captureFromGuest(guest)
    if (!shouldPersistWebChatLoginCapture(baselineSnapshotRef.current, captured)) return
    await agentEnhancerSaveWebChatLogin.invoke(remoteSource, {
      localStorage: captured!.localStorage,
      cookie: captured!.cookie,
      savedAt: captured!.savedAt,
    })
    baselineSnapshotRef.current = captured
  }, [remoteSource])

  const applyPendingSnapshot = useCallback(async (): Promise<'applied' | 'reloading' | 'skipped'> => {
    const guest = guestRef.current
    const snapshot = pendingSnapshotRef.current
    if (guest === null || snapshot === null || snapshotLoadedRef.current) return 'skipped'
    try {
      const result = await guest.executeJavaScript(buildWebChatLoginRestoreScript(snapshot), true)
      if (webChatLoginRestoreApplied(result)) snapshotLoadedRef.current = true
      if (webChatLoginRestoreNeedsWait(result)) return 'reloading'
      return webChatLoginRestoreApplied(result) ? 'applied' : 'skipped'
    } catch {
      // Best-effort; HttpOnly cookies may still require re-login. A failed or
      // off-origin attempt stays unmarked so a later official load can write.
      return 'skipped'
    }
  }, [])

  /** Dismiss chat.deepseek.com “使用环境异常” via site localStorage, then restore login. */
  const settleOfficialGuest = useCallback(async () => {
    const guest = guestRef.current
    if (guest === null) return
    let pref: unknown = 'unavailable'
    try {
      pref = await guest.executeJavaScript(buildWebChatGuestPreferencesScript(), false)
      if (webChatGuestPreferencesNeedsWait(pref)) return
    } catch {
      // Scripting may be denied; keep the site’s own banner behaviour.
    }
    const restore = await applyPendingSnapshot()
    if (restore === 'reloading') return
    try {
      await guest.executeJavaScript(buildWebChatClipboardBridgeScript(), false)
    } catch {
      // Clipboard bridge is best-effort for in-page Copy buttons.
    }
    if (webChatGuestPreferencesAllowsReveal(pref)) {
      setSurfaceReady(true)
      void persistSnapshot()
    }
  }, [applyPendingSnapshot, persistSnapshot])

  useEffect(() => {
    let cancelled = false
    const bridge = desktopBrowserBridge()
    if (bridge === null) {
      setPhase('degraded')
      setErrorKey('webChatGuestBridgeMissing')
      return () => { cancelled = true }
    }

    const run = async () => {
      setPhase('acquiring')
      setErrorKey(null)
      try {
        const reservation = await bridge.acquire(WEB_CHAT_BRIDGE_STORAGE_ID)
        if (cancelled) {
          await bridge.release(reservation.lease).catch(() => undefined)
          return
        }
        leaseRef.current = reservation.lease
        setLease(reservation.lease)
        setPartition(reservation.partition)
        if (typeof bridge.onOpenRequested === 'function') {
          openDisposeRef.current = bridge.onOpenRequested(reservation.lease, detail => {
            const guest = guestRef.current
            if (guest === null) return
            const url = typeof detail === 'string'
              ? detail
              : (typeof detail === 'object' && detail !== null && typeof detail.url === 'string'
                ? detail.url
                : '')
            if (isAllowedWebChatGuestOpenUrl(url)) guest.loadURL(url)
          })
        }
        const loaded = await agentEnhancerLoadWebChatLogin.invoke(remoteSource)
        pendingSnapshotRef.current = loaded.snapshot
        baselineSnapshotRef.current = loaded.snapshot
        setPhase('ready')
      } catch {
        openDisposeRef.current?.()
        openDisposeRef.current = null
        const failedLease = leaseRef.current
        leaseRef.current = null
        setLease(null)
        setPartition(null)
        if (failedLease !== null) {
          await bridge.release(failedLease).catch(() => undefined)
        }
        if (!cancelled) {
          setPhase('degraded')
          setErrorKey('webChatGuestLoadFailed')
        }
      }
    }
    void run()

    return () => {
      cancelled = true
      openDisposeRef.current?.()
      openDisposeRef.current = null
      const activeLease = leaseRef.current
      leaseRef.current = null
      setLease(null)
      setPartition(null)
      const guest = guestRef.current
      if (guest !== null) {
        void captureFromGuest(guest).then(captured => {
          if (!shouldPersistWebChatLoginCapture(baselineSnapshotRef.current, captured)) return
          return agentEnhancerSaveWebChatLogin.invoke(remoteSource, {
            localStorage: captured!.localStorage,
            cookie: captured!.cookie,
            savedAt: captured!.savedAt,
          })
        }).catch(() => undefined)
      }
      if (activeLease !== null) {
        void bridge.release(activeLease).catch(() => undefined)
      }
    }
  }, [remoteSource])

  const mountGuestHost = useCallback((host: HTMLDivElement | null) => {
    if (host === null) {
      guestRef.current = null
      setGuestNode(null)
      officialLoadedRef.current = false
      userAgentPatchedRef.current = false
      setSurfaceReady(false)
      return
    }
    if (phase !== 'ready' || lease === null || partition === null) return
    if (host.querySelector('webview') !== null) return

    // Match Desktop sidebar-browser: createElement + about:blank#lease, then loadURL.
    const element = document.createElement('webview') as GuestWebView
    element.className = styles.webChatBridgeGuestWebview ?? ''
    element.setAttribute('name', lease)
    element.setAttribute('partition', partition)
    element.setAttribute('allowpopups', '')
    element.setAttribute('src', buildWebChatGuestBootstrapSrc(lease))
    host.appendChild(element)
    guestRef.current = element
    setSurfaceReady(false)
    setGuestNode(element)
  }, [phase, lease, partition])

  useEffect(() => {
    if (phase !== 'ready' || guestNode === null) return

    const bootOfficial = () => {
      if (officialLoadedRef.current) return
      officialLoadedRef.current = true
      try {
        // Best-effort: drop Electron/… before the first official navigation (peer: dsh-webview).
        if (!userAgentPatchedRef.current && typeof guestNode.setUserAgent === 'function') {
          const current = typeof guestNode.getUserAgent === 'function'
            ? guestNode.getUserAgent()
            : (typeof navigator !== 'undefined' ? navigator.userAgent : '')
          if (current !== '') {
            guestNode.setUserAgent(stripElectronFromUserAgent(current))
            userAgentPatchedRef.current = true
          }
        }
        guestNode.loadURL(WEB_CHAT_BRIDGE_URL)
      } catch {
        officialLoadedRef.current = false
        setPhase('degraded')
        setErrorKey('webChatGuestLoadFailed')
      }
    }

    const onReady = () => {
      bootOfficial()
      void settleOfficialGuest()
    }
    const onNavigate = () => {
      void settleOfficialGuest()
      void persistSnapshot()
    }

    const allowClipboardPermission = (event: Event) => {
      const detail = event as Event & {
        readonly permission?: string
        readonly request?: { allow?: () => void, deny?: () => void }
        granted?: boolean
      }
      const permission = typeof detail.permission === 'string' ? detail.permission : ''
      if (
        permission !== 'clipboard-sanitized-write'
        && permission !== 'clipboard-read'
        && permission !== 'clipboard'
      ) {
        return
      }
      if (typeof detail.request?.allow === 'function') {
        detail.request.allow()
        return
      }
      detail.granted = true
      if (typeof (event as { preventDefault?: () => void }).preventDefault === 'function') {
        event.preventDefault()
      }
    }

    const onConsoleMessage = (event: Event) => {
      const message = Reflect.get(event, 'message')
      if (typeof message !== 'string' || !message.startsWith(WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX)) {
        return
      }
      const encoded = message.slice(WEB_CHAT_CLIPBOARD_CONSOLE_PREFIX.length)
      let text = ''
      try {
        text = decodeURIComponent(encoded)
      } catch {
        text = encoded
      }
      void writeHostClipboard(text)
    }

    guestNode.addEventListener('dom-ready', onReady as EventListener)
    guestNode.addEventListener('did-finish-load', onReady as EventListener)
    guestNode.addEventListener('did-navigate-in-page', onNavigate as EventListener)
    guestNode.addEventListener('permission-request', allowClipboardPermission as EventListener)
    guestNode.addEventListener('permissionrequest', allowClipboardPermission as EventListener)
    guestNode.addEventListener('permission-check', allowClipboardPermission as EventListener)
    guestNode.addEventListener('console-message', onConsoleMessage as EventListener)

    const interval = window.setInterval(() => { void persistSnapshot() }, 60_000)

    return () => {
      guestNode.removeEventListener('dom-ready', onReady as EventListener)
      guestNode.removeEventListener('did-finish-load', onReady as EventListener)
      guestNode.removeEventListener('did-navigate-in-page', onNavigate as EventListener)
      guestNode.removeEventListener('permission-request', allowClipboardPermission as EventListener)
      guestNode.removeEventListener('permissionrequest', allowClipboardPermission as EventListener)
      guestNode.removeEventListener('permission-check', allowClipboardPermission as EventListener)
      guestNode.removeEventListener('console-message', onConsoleMessage as EventListener)
      window.clearInterval(interval)
    }
  }, [phase, guestNode, settleOfficialGuest, persistSnapshot])

  return {
    phase,
    errorKey,
    lease,
    partition,
    surfaceReady,
    guestRef,
    mountGuestHost,
  }
}

export interface WebChatBridgeGuestBodyProps {
  readonly guest: WebChatBridgeGuestState
  readonly t: (key: 'webChatPreparing' | 'webChatGuestBridgeMissing' | 'webChatGuestLoadFailed') => string
}

export function WebChatBridgeGuestBody(props: WebChatBridgeGuestBodyProps) {
  const guest = props.guest

  if (guest.phase === 'degraded' && guest.errorKey !== null) {
    return (
      <p className={`${styles.managerEmpty} ${styles.webChatBridgeGuestError}`}>
        {props.t(guest.errorKey)}
      </p>
    )
  }

  if (guest.phase !== 'ready' || guest.partition === null || guest.lease === null) {
    return (
      <p className={`${styles.managerEmpty} ${styles.webChatBridgeGuestError}`}>
        {props.t('webChatPreparing')}
      </p>
    )
  }

  return (
    <>
      <div
        ref={guest.mountGuestHost}
        className={styles.webChatBridgeGuestHost}
        data-web-chat-guest-host=""
        data-ready={guest.surfaceReady ? 'true' : undefined}
        aria-hidden={guest.surfaceReady ? undefined : true}
      />
      {guest.surfaceReady ? null : (
        <p className={`${styles.managerEmpty} ${styles.webChatBridgeGuestError}`}>
          {props.t('webChatPreparing')}
        </p>
      )}
    </>
  )
}
