import { useCallback, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  extractWebChatShareId,
  parseWebChatHistoryMessages,
} from '../../host/web-chat-bridge/share-link.ts'
import type { WebChatTranscript } from '../../host/web-chat-bridge/types.ts'
import { ManagerAddSheet, ManagerPage, ManagerPageHead } from '../manager-shell.tsx'
import styles from '../styles.module.css'
import { captureFromDocument, chatSessionIdFromUrl } from './capture.ts'
import { readWebChatGuestBrowseContext } from './guest-capture.ts'
import { WebChatBridgeGuestBody, useWebChatBridgeGuest } from './guest.tsx'
import type { WEB_CHAT_PANEL_ID } from './kind.ts'
import { WebChatBridgePreview } from './preview.tsx'
import {
  agentEnhancerResolveWebChatShareLink,
  WebChatBridgeRemoteError,
  type WebChatBridgeRemoteSource,
} from './remote.ts'
import {
  fetchWebChatHistoryPayloadFromGuest,
  fetchWebChatSharePayloadFromGuest,
} from './share-fetch.ts'

export interface WebChatBridgePanelProps {
  readonly remote: WebChatBridgeRemoteSource
  readonly t: TranslateNS<'agent-enhancer'>
  readonly onLeavePanel?: () => void
  readonly onOpenSession?: (sessionId: SessionId) => void
}

export type WebChatBridgeMainPanelProps =
  & PropsRuntime<'main', typeof WEB_CHAT_PANEL_ID>
  & WebChatBridgePanelProps

function captureErrorMessage(error: unknown, t: TranslateNS<'agent-enhancer'>): string {
  if (!(error instanceof Error)) return t('webChatCaptureFailed')
  const message = error.message
  if (/generating/i.test(message)) return t('webChatCaptureGenerating')
  if (/unsent|draft/i.test(message)) return t('webChatCaptureUnsentDraft')
  if (/empty|no messages/i.test(message)) return t('webChatCaptureEmpty')
  if (/too.?large|limit/i.test(message)) return t('webChatExportTooLarge')
  if (/selector|selectors|structure|unrecognized/i.test(message)) return t('webChatCaptureStructure')
  return message.trim() === '' ? t('webChatCaptureFailed') : message
}

function shareErrorMessage(error: unknown, t: TranslateNS<'agent-enhancer'>): string {
  if (error instanceof WebChatBridgeRemoteError) {
    if (error.webChatCode === 'invalid-transcript') {
      const message = error.message
      if (/unrecognized-share:\s*not a DeepSeek share link/i.test(message)) {
        return t('webChatShareUnrecognized')
      }
      if (/too.?large|limit|exceeds/i.test(message)) return t('webChatExportTooLarge')
      if (/no messages|empty/i.test(message)) return t('webChatCaptureEmpty')
      if (/share-api|Share link has no messages|unrecognized-share/i.test(message)) {
        return t('webChatShareFetchFailed')
      }
      return message.trim() === '' ? t('webChatImportInvalid') : message
    }
    return error.message || t('webChatImportFailed')
  }
  return captureErrorMessage(error, t)
}

function WebChatBridgePanel(props: WebChatBridgePanelProps) {
  const guest = useWebChatBridgeGuest({ remote: props.remote })
  const [chooserOpen, setChooserOpen] = useState(false)
  const [shareUrl, setShareUrl] = useState('')
  const [previewTranscript, setPreviewTranscript] = useState<WebChatTranscript | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [toast, setToast] = useState<{ text: string, tone?: 'success' } | null>(null)
  const [busy, setBusy] = useState(false)

  const captureEnabled = guest.phase === 'ready' && guest.partition !== null

  const showError = useCallback((message: string) => {
    setToast({ text: message })
  }, [])

  const captureCurrentTranscript = useCallback(async (): Promise<WebChatTranscript | null> => {
    if (!captureEnabled) {
      showError(props.t('webChatCaptureGuestNotReady'))
      return null
    }
    const context = await readWebChatGuestBrowseContext(guest.guestRef.current)
    if (context === null || context.document === null) {
      showError(props.t('webChatCaptureStructure'))
      return null
    }
    // Prefer history_messages (same markdown fragments as share links) when the
    // open URL carries /s/{chatSessionId}. Fall back to improved DOM→Markdown.
    const sessionId = chatSessionIdFromUrl(context.url)
    if (sessionId !== undefined) {
      const payloadJson = await fetchWebChatHistoryPayloadFromGuest(
        guest.guestRef.current,
        sessionId,
      )
      if (payloadJson !== null) {
        try {
          return parseWebChatHistoryMessages(JSON.parse(payloadJson) as unknown, {
            chatSessionId: sessionId,
            url: context.url,
          })
        } catch {
          // fall through to rendered capture
        }
      }
    }
    return captureFromDocument(context.document, {
      url: context.url,
      isGenerating: () => context.isGenerating,
      hasUnsentDraft: () => context.hasUnsentDraft,
    })
  }, [captureEnabled, guest.guestRef, props, showError])

  const openPreview = useCallback((transcript: WebChatTranscript) => {
    setChooserOpen(false)
    setPreviewTranscript(transcript)
    setPreviewOpen(true)
  }, [])

  const onChooseCurrent = useCallback(async () => {
    setBusy(true)
    try {
      const transcript = await captureCurrentTranscript()
      if (transcript === null) return
      openPreview(transcript)
    } catch (caught) {
      showError(captureErrorMessage(caught, props.t))
    } finally {
      setBusy(false)
    }
  }, [captureCurrentTranscript, openPreview, props, showError])

  const onResolveShare = useCallback(async () => {
    const raw = shareUrl.trim()
    if (raw === '') {
      showError(props.t('webChatShareEmpty'))
      return
    }
    if (extractWebChatShareId(raw) === null) {
      showError(props.t('webChatShareUnrecognized'))
      return
    }
    setBusy(true)
    try {
      const payloadJson = captureEnabled
        ? await fetchWebChatSharePayloadFromGuest(guest.guestRef.current, raw)
        : null
      const { transcript } = await agentEnhancerResolveWebChatShareLink.invoke(props.remote, {
        shareUrl: raw,
        ...(payloadJson === null ? {} : { payloadJson }),
      })
      openPreview(transcript)
    } catch (caught) {
      showError(shareErrorMessage(caught, props.t))
    } finally {
      setBusy(false)
    }
  }, [captureEnabled, guest.guestRef, openPreview, props, shareUrl, showError])

  const onImported = useCallback((sessionId: SessionId) => {
    props.onLeavePanel?.()
    props.onOpenSession?.(sessionId)
    setToast({ text: props.t('webChatImportSuccess'), tone: 'success' })
  }, [props])

  return (
    <ManagerPage className={styles.webChatBridgePage}>
      <ManagerPageHead
        title={props.t('webChatTitle')}
        intro={props.t('webChatIntro')}
        toolbar={(
          <Button
            variant="outline"
            size="sm"
            disabled={busy || guest.phase === 'degraded'}
            onClick={() => { setChooserOpen(true) }}
          >
            {props.t('webChatToWorkspace')}
          </Button>
        )}
      />
      <div className={styles.webChatBridgeBody}>
        <main className={styles.webChatBridgeGuest}>
          <WebChatBridgeGuestBody guest={guest} t={props.t} />
        </main>
      </div>

      <ManagerAddSheet
        open={chooserOpen && !previewOpen}
        title={props.t('webChatChooserTitle')}
        closeLabel={props.t('webChatChooserCancel')}
        onClose={() => {
          if (!busy) setChooserOpen(false)
        }}
        footer={(
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { setChooserOpen(false) }}
          >
            {props.t('webChatChooserCancel')}
          </Button>
        )}
      >
        <p className={styles.webChatChooserIntro}>{props.t('webChatChooserIntro')}</p>
        <div className={styles.webChatChooserOptions} role="list">
          <button
            type="button"
            className={styles.webChatChooserOption}
            disabled={busy || !captureEnabled}
            onClick={() => { void onChooseCurrent() }}
          >
            <span className={styles.webChatChooserOptionTitle}>
              {props.t('webChatChooserCurrentTitle')}
            </span>
            <span className={styles.webChatChooserOptionDesc}>
              {props.t('webChatChooserCurrentDesc')}
            </span>
          </button>

          <div className={styles.webChatChooserShare}>
            <span className={styles.webChatChooserOptionTitle}>
              {props.t('webChatChooserShareTitle')}
            </span>
            <span className={styles.webChatChooserOptionDesc}>
              {props.t('webChatChooserShareDesc')}
            </span>
            <div className={styles.webChatChooserShareRow}>
              <input
                className={styles.managerScopeSelect}
                type="url"
                value={shareUrl}
                disabled={busy}
                placeholder={props.t('webChatChooserSharePlaceholder')}
                onChange={event => { setShareUrl(event.target.value) }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void onResolveShare()
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={busy || shareUrl.trim() === ''}
                onClick={() => { void onResolveShare() }}
              >
                {props.t('webChatChooserShareSubmit')}
              </Button>
            </div>
          </div>
        </div>
      </ManagerAddSheet>

      <WebChatBridgePreview
        open={previewOpen}
        transcript={previewTranscript}
        remote={props.remote}
        t={props.t}
        onClose={() => {
          setPreviewOpen(false)
          setPreviewTranscript(null)
        }}
        onImported={onImported}
      />
      {toast === null ? null : (
        <Toast
          text={toast.text}
          tone={toast.tone}
          onDone={() => setToast(null)}
        />
      )}
    </ManagerPage>
  )
}

export function WebChatBridgeMainPanel(props: WebChatBridgeMainPanelProps) {
  return <WebChatBridgePanel {...props} />
}
