import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AuxiliaryError } from '../../errors.ts'
import { agentEnhancerDeleteSession } from './remote.ts'
import {
  getPendingSessionDelete,
  settleSessionDeleteRequest,
  subscribeSessionDelete,
} from './store.ts'
import styles from '../styles.module.css'

export interface SessionDeleteOverlayProps {
  readonly remote: unknown
  readonly t: TranslateNS<'agent-enhancer'>
  readonly ctx?: { get?: (key: string) => unknown }
}

function usePendingRequest() {
  return useSyncExternalStore(subscribeSessionDelete, getPendingSessionDelete, getPendingSessionDelete)
}

export function SessionDeleteOverlay(props: SessionDeleteOverlayProps) {
  const request = usePendingRequest()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => setToast(null), 3200)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    setError(null)
    setDeleting(false)
  }, [request?.sessionId])

  const leaveDeletedConversation = (workspaceId: string | undefined) => {
    try {
      const uiWorkspace = props.ctx?.get?.('uiWorkspace') as {
        startSession?: (workspaceId?: string) => void
      } | undefined
      if (typeof uiWorkspace?.startSession !== 'function') return
      if (typeof workspaceId === 'string' && workspaceId !== '') uiWorkspace.startSession(workspaceId)
      else uiWorkspace.startSession()
    } catch {
      // Navigation is best-effort after a successful delete.
    }
  }

  const callDelete = async (sessionId: string) => {
    setDeleting(true)
    setError(null)
    const wasOpen = request?.wasOpen === true
    const workspaceId = request?.workspaceId
    try {
      if (props.remote === undefined || props.remote === null) {
        throw new AuxiliaryError('SESSION_DELETE_FAILED', 'remote is not ready')
      }
      const result = await agentEnhancerDeleteSession.invoke(
        props.remote,
        sessionId as SessionId,
      )
      const toastKey = result.unloaded
        ? 'sessionDeleteDoneUnloaded'
        : result.live
          ? 'sessionDeleteDoneHidden'
          : 'sessionDeleteDone'
      setToast(props.t(toastKey))
      settleSessionDeleteRequest()
      try {
        const sessions = props.ctx?.get?.('sessions') as { refresh?: () => Promise<unknown> } | undefined
        const refreshed = sessions?.refresh?.()
        if (refreshed !== undefined && typeof refreshed.catch === 'function') {
          void refreshed.catch(() => undefined)
        }
      } catch {
        // Refresh is convenience only.
      }
      if (wasOpen && !result.live) {
        window.setTimeout(() => leaveDeletedConversation(workspaceId), 0)
      }
    } catch (reason) {
      if (reason instanceof AuxiliaryError && reason.code === 'SESSION_BUSY') {
        setError(props.t('sessionDeleteBusyConfirm'))
      } else if (reason instanceof AuxiliaryError && reason.message.trim() !== '') {
        setError(props.t('sessionDeleteFailedDetail', { message: reason.message }))
      } else {
        setError(props.t('sessionDeleteFailed'))
      }
    } finally {
      setDeleting(false)
    }
  }

  return createElement(
    'div',
    { className: styles.sessionDeleteRoot },
    request !== null
      ? createElement('div', {
        className: styles.sessionDeleteOverlay,
        role: 'presentation',
      }, createElement('div', {
        className: styles.sessionDeleteDialog,
        role: 'dialog',
        'aria-modal': true,
        'aria-label': props.t('sessionDeleteConfirmTitle'),
      },
      createElement('h2', { className: styles.sessionDeleteTitle }, props.t('sessionDeleteConfirmTitle')),
      createElement('p', { className: styles.sessionDeleteDesc }, props.t('sessionDeleteConfirmDesc', {
        title: request.displayTitle || request.sessionId,
      })),
      error !== null
        ? createElement('p', { className: styles.sessionDeleteWarn }, error)
        : null,
      createElement('div', { className: styles.sessionDeleteFooter },
        createElement('button', {
          type: 'button',
          className: styles.sessionDeleteBtn,
          disabled: deleting,
          onClick: () => { if (!deleting) settleSessionDeleteRequest() },
        }, props.t('sessionDeleteCancel')),
        createElement('button', {
          type: 'button',
          className: styles.sessionDeleteBtnDanger,
          disabled: deleting,
          onClick: () => { void callDelete(request.sessionId) },
        }, deleting ? props.t('sessionDeleteDeleting') : props.t('sessionDeleteConfirmAction')),
      ),
      ))
      : null,
    toast !== null
      ? createElement('div', { className: styles.sessionDeleteToast }, toast)
      : null,
  )
}
