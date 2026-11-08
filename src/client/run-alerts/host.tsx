import { createElement, useEffect, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RunAlertsLevel } from '../../config.ts'
import { runAlertBody } from './copy.ts'
import { RunAlertDedupe } from './dedupe.ts'
import { detectSessionError, detectStatusEdges } from './detect.ts'
import { showSystemNotification } from './deliver.ts'
import { deliverChannel, isAway, shouldDeliverAlert } from './gate.ts'
import type { RunAlertEvent, SessionStatusFace, SessionStatusMap } from './types.ts'

export interface RunAlertsHostProps {
  readonly t: TranslateNS<'agent-enhancer'>
  /** Cordis client context — typed loosely so Desktop Context assigns cleanly. */
  readonly ctx?: { get?: (key: string) => unknown; remote?: unknown }
  readonly useSessionStatus?: PropsRuntime<'shell.overlay'>['useSessionStatus']
  /** Latest level from settings (read on each deliver). */
  readonly getLevel: () => RunAlertsLevel
  /** Host remote for Electron / Windows OS notifications. */
  readonly getRemote?: () => unknown
}

interface ToastBanner {
  readonly key: number
  readonly text: string
  readonly tone?: 'success'
}

function asStatusMap(snapshot: unknown): SessionStatusMap {
  if (snapshot instanceof Map) {
    return snapshot as SessionStatusMap
  }
  const map = new Map<SessionId, SessionStatusFace>()
  if (snapshot !== null && typeof snapshot === 'object') {
    for (const [key, value] of Object.entries(snapshot as Record<string, SessionStatusFace>)) {
      map.set(key as SessionId, value)
    }
  }
  return map
}

function sessionListSnapshot(ctx: RunAlertsHostProps['ctx']): {
  byId?: Record<string, { displayTitle?: string; title?: string; retainedBy?: { mainView?: number } }>
} | undefined {
  try {
    const sessions = ctx?.get?.('sessions') as {
      list?: {
        getSnapshot?: () => unknown
        value?: unknown
      }
    } | undefined
    const snap = sessions?.list?.getSnapshot?.() ?? sessions?.list?.value
    if (snap !== null && typeof snap === 'object') {
      return snap as {
        byId?: Record<string, { displayTitle?: string; title?: string; retainedBy?: { mainView?: number } }>
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

function titleFor(ctx: RunAlertsHostProps['ctx'], sessionId: SessionId): string {
  const list = sessionListSnapshot(ctx)
  const row = list?.byId?.[sessionId]
  const display = typeof row?.displayTitle === 'string' ? row.displayTitle.trim() : ''
  if (display !== '') return display
  const durable = typeof row?.title === 'string' ? row.title.trim() : ''
  if (durable !== '') return durable
  return String(sessionId)
}

function isMainViewSession(ctx: RunAlertsHostProps['ctx'], sessionId: SessionId): boolean {
  try {
    const sessions = ctx?.get?.('sessions') as {
      retainInfo?: (id: string) => { getSnapshot?: () => { retainedBy?: { mainView?: number } } }
    } | undefined
    const info = sessions?.retainInfo?.(sessionId)?.getSnapshot?.()
    if (info !== undefined) return (info.retainedBy?.mainView ?? 0) > 0
  } catch {
    // fall through to list row
  }
  const row = sessionListSnapshot(ctx)?.byId?.[sessionId]
  return (row?.retainedBy?.mainView ?? 0) > 0
}

function readWindowFocused(): boolean {
  try {
    return typeof document !== 'undefined' && document.hasFocus()
  } catch {
    return true
  }
}

export function RunAlertsHost(props: RunAlertsHostProps) {
  const previousRef = useRef<SessionStatusMap | undefined>(undefined)
  const dedupeRef = useRef(new RunAlertDedupe())
  const toastSeq = useRef(0)
  const propsRef = useRef(props)
  propsRef.current = props
  const hiddenRef = useRef(
    typeof document !== 'undefined' && document.visibilityState === 'hidden',
  )
  const focusedRef = useRef(readWindowFocused())
  const pendingToastRef = useRef<ToastBanner | null>(null)
  const [toast, setToast] = useState<ToastBanner | null>(null)
  const [awayTick, setAwayTick] = useState(0)

  const statusSnapshot = typeof props.useSessionStatus === 'function'
    ? props.useSessionStatus(snapshot => snapshot)
    : undefined

  const syncAway = () => {
    hiddenRef.current = document.visibilityState === 'hidden'
    focusedRef.current = readWindowFocused()
    setAwayTick(value => value + 1)
    if (focusedRef.current && !hiddenRef.current && pendingToastRef.current !== null) {
      const pending = pendingToastRef.current
      pendingToastRef.current = null
      setToast(pending)
    }
  }

  useEffect(() => {
    const onVisibility = () => { syncAway() }
    const onFocus = () => { syncAway() }
    const onBlur = () => { syncAway() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  const showToast = (banner: Omit<ToastBanner, 'key'>) => {
    toastSeq.current += 1
    const next = { key: toastSeq.current, ...banner }
    if (!focusedRef.current || hiddenRef.current) {
      pendingToastRef.current = next
      return
    }
    setToast(next)
  }

  const deliver = (event: RunAlertEvent) => {
    const current = propsRef.current
    const hidden = hiddenRef.current
    const focused = focusedRef.current
    const level = current.getLevel()
    if (!dedupeRef.current.accept(event)) return
    if (!shouldDeliverAlert({
      level,
      documentHidden: hidden,
      windowFocused: focused,
      isMainView: isMainViewSession(current.ctx, event.sessionId),
    })) return

    const body = runAlertBody(current.t, event, titleFor(current.ctx, event.sessionId))
    const channel = deliverChannel({ documentHidden: hidden, windowFocused: focused })
    const tone = event.kind === 'finished' ? 'success' as const : undefined

    if (channel === 'notification') {
      void showSystemNotification({
        title: current.t('runAlerts'),
        body,
        tag: `agent-enhancer-run-alert:${event.sessionId}:${event.kind}`,
        remote: current.getRemote?.(),
      }).then(ok => {
        if (ok) return
        // OS path unavailable — show Toast when the user returns (not while away).
        showToast({ text: body, tone })
      })
      return
    }

    showToast({ text: body, tone })
  }

  useEffect(() => {
    if (statusSnapshot === undefined) return
    const next = asStatusMap(statusSnapshot)
    const edges = detectStatusEdges(previousRef.current, next, {
      away: isAway(hiddenRef.current, focusedRef.current),
    })
    previousRef.current = next
    for (const event of edges) deliver(event)
  }, [statusSnapshot, awayTick])

  useEffect(() => {
    const remote = props.ctx?.remote as {
      $on?: (event: string, handler: (...args: unknown[]) => void) => (() => void) | void
    } | undefined
    if (remote === undefined || typeof remote.$on !== 'function') return
    const off = remote.$on('api-session/error', (sessionId: unknown, message: unknown) => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const text = typeof message === 'string' ? message : String(message ?? '')
      deliver(detectSessionError(sessionId as SessionId, text))
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [props.ctx?.remote])

  if (toast === null) return null
  return createElement(Toast, {
    key: toast.key,
    text: toast.text,
    tone: toast.tone,
    onDone: () => setToast(current => (current?.key === toast.key ? null : current)),
  })
}
