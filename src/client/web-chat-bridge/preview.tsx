import { useCallback, useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WebChatTranscript } from '../../host/web-chat-bridge/types.ts'
import type { WebChatWorkspaceRow } from '../../host/web-chat-bridge/import-session.ts'
import { ManagerAddSheet } from '../manager-shell.tsx'
import styles from '../styles.module.css'
import {
  buildWebChatImportRequest,
  pickDefaultWebChatWorkspace,
  truncatePreviewTurnText,
} from './preview-model.ts'
import {
  agentEnhancerCreateWebChatWorkspace,
  agentEnhancerImportWebChatHistory,
  agentEnhancerListWebChatWorkspaces,
  WebChatBridgeRemoteError,
  type WebChatBridgeRemoteSource,
} from './remote.ts'

export interface WebChatBridgePreviewProps {
  readonly open: boolean
  readonly transcript: WebChatTranscript | null
  readonly remote: WebChatBridgeRemoteSource
  readonly t: TranslateNS<'agent-enhancer'>
  readonly onClose: () => void
  readonly onImported: (sessionId: SessionId) => void
}

function sourceLine(transcript: WebChatTranscript, t: TranslateNS<'agent-enhancer'>): string {
  const { source } = transcript
  if (source.kind === 'official-export') {
    const name = source.filename ?? ''
    return name === ''
      ? t('webChatPreviewSourceExport')
      : t('webChatPreviewSourceExportFile').replace('{filename}', name)
  }
  if (source.kind === 'account-history') {
    return t('webChatPreviewSourceAccount')
  }
  if (source.kind === 'share-link') {
    const url = source.url ?? ''
    return url === ''
      ? t('webChatPreviewSourceShare')
      : t('webChatPreviewSourceShareUrl').replace('{url}', url)
  }
  const url = source.url ?? ''
  return url === ''
    ? t('webChatPreviewSourceCapture')
    : t('webChatPreviewSourceCaptureUrl').replace('{url}', url)
}

function remoteErrorMessage(error: unknown, t: TranslateNS<'agent-enhancer'>): string {
  if (error instanceof WebChatBridgeRemoteError) {
    switch (error.webChatCode) {
      case 'no-workspace':
        return t('webChatImportNoWorkspace')
      case 'invalid-transcript':
        return t('webChatImportInvalid')
      default:
        return error.message || t('webChatImportFailed')
    }
  }
  if (error instanceof Error && error.message.trim() !== '') return error.message
  return t('webChatImportFailed')
}

export function WebChatBridgePreview(props: WebChatBridgePreviewProps) {
  const transcript = props.transcript
  const [workspaces, setWorkspaces] = useState<readonly WebChatWorkspaceRow[]>([])
  const [workspaceId, setWorkspaceId] = useState('')
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applyWorkspaceList = useCallback((
    items: readonly WebChatWorkspaceRow[],
    preferId?: string,
  ) => {
    setWorkspaces(items)
    const preferred = preferId !== undefined && items.some(row => row.id === preferId)
      ? preferId
      : pickDefaultWebChatWorkspace(items)
    setWorkspaceId(preferred ?? '')
    if (preferred === null) {
      setError(props.t('webChatPreviewNoWorkspace'))
    } else {
      setError(null)
    }
  }, [props])

  const loadWorkspaces = useCallback(async () => {
    setLoadingWorkspaces(true)
    setError(null)
    try {
      const result = await agentEnhancerListWebChatWorkspaces.invoke(props.remote)
      applyWorkspaceList(result.items)
    } catch (caught) {
      setWorkspaces([])
      setWorkspaceId('')
      setError(remoteErrorMessage(caught, props.t))
    } finally {
      setLoadingWorkspaces(false)
    }
  }, [applyWorkspaceList, props])

  useEffect(() => {
    if (!props.open || transcript === null) return
    void loadWorkspaces()
  }, [props.open, transcript, loadWorkspaces])

  useEffect(() => {
    if (props.open) return
    setError(null)
    setImporting(false)
    setCreatingWorkspace(false)
  }, [props.open])

  const onCreateWorkspace = async () => {
    setCreatingWorkspace(true)
    setError(null)
    try {
      const result = await agentEnhancerCreateWebChatWorkspace.invoke(props.remote)
      if (result.cancelled) return
      if (result.workspace === null) {
        setError(props.t('webChatPreviewCreateWorkspaceFailed'))
        return
      }
      const listed = await agentEnhancerListWebChatWorkspaces.invoke(props.remote)
      const items = listed.items.some(row => row.id === result.workspace!.id)
        ? listed.items
        : [result.workspace, ...listed.items]
      applyWorkspaceList(items, result.workspace.id)
    } catch (caught) {
      setError(remoteErrorMessage(caught, props.t) || props.t('webChatPreviewCreateWorkspaceFailed'))
    } finally {
      setCreatingWorkspace(false)
    }
  }

  const busy = importing || creatingWorkspace || loadingWorkspaces
  const canConfirm = transcript !== null
    && workspaceId.trim() !== ''
    && !busy
    && workspaces.length > 0

  const onConfirm = async () => {
    if (transcript === null || workspaceId.trim() === '') return
    setImporting(true)
    setError(null)
    try {
      const payload = buildWebChatImportRequest(workspaceId, transcript)
      const { sessionId } = await agentEnhancerImportWebChatHistory.invoke(props.remote, payload)
      props.onImported(sessionId)
      props.onClose()
    } catch (caught) {
      setError(remoteErrorMessage(caught, props.t))
    } finally {
      setImporting(false)
    }
  }

  if (!props.open || transcript === null) return null

  return (
    <>
      <ManagerAddSheet
        open={props.open}
        title={props.t('webChatPreviewTitle')}
        closeLabel={props.t('webChatPreviewCancel')}
        onClose={() => {
          if (!busy) props.onClose()
        }}
        footer={(
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={props.onClose}
            >
              {props.t('webChatPreviewCancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canConfirm}
              onClick={() => { void onConfirm() }}
            >
              {importing ? props.t('webChatPreviewImporting') : props.t('webChatPreviewConfirm')}
            </Button>
          </>
        )}
      >
        <div className={styles.webChatPreviewMeta}>
          <h3 className={styles.webChatPreviewTitle}>{transcript.title}</h3>
          <p className={styles.webChatPreviewSource}>{sourceLine(transcript, props.t)}</p>
          {transcript.partial ? (
            <p className={styles.webChatPreviewPartial} role="status">
              {props.t('webChatPreviewPartial')}
            </p>
          ) : null}
        </div>

        <div className={styles.webChatPreviewWorkspaceRow}>
          <label className={styles.managerField}>
            <span className={styles.managerFieldLabel}>{props.t('webChatPreviewWorkspace')}</span>
            <select
              className={styles.managerScopeSelect}
              value={workspaceId}
              disabled={busy || workspaces.length === 0}
              onChange={event => { setWorkspaceId(event.target.value) }}
            >
              {workspaces.length === 0 ? (
                <option value="">{props.t('webChatPreviewNoWorkspace')}</option>
              ) : workspaces.map(row => (
                <option key={row.id} value={row.id}>{row.title}</option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { void onCreateWorkspace() }}
          >
            {creatingWorkspace
              ? props.t('webChatPreviewCreatingWorkspace')
              : props.t('webChatPreviewCreateWorkspace')}
          </Button>
        </div>

        <p className={styles.webChatPreviewTurnCount}>
          {props.t('webChatPreviewTurnCount').replace('{count}', String(transcript.turns.length))}
        </p>

        <ul className={styles.webChatPreviewTurns} aria-label={props.t('webChatPreviewTurnList')}>
          {transcript.turns.map((turn, index) => (
            <li key={`${turn.role}-${index}`} className={styles.webChatPreviewTurn}>
              <span className={styles.webChatPreviewTurnRole}>
                {turn.role === 'user' ? props.t('webChatRoleUser') : props.t('webChatRoleAssistant')}
              </span>
              <p className={styles.webChatPreviewTurnText}>
                {truncatePreviewTurnText(turn.text)}
              </p>
            </li>
          ))}
        </ul>

        {error !== null ? (
          <p className={styles.webChatPreviewError} role="alert">{error}</p>
        ) : null}
      </ManagerAddSheet>
    </>
  )
}
