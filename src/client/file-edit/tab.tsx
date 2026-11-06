import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AuxiliaryError } from '../../errors.ts'
import styles from '../styles.module.css'
import { basenameOfPath, parseWorkspaceFileAddress } from './address.ts'
import { FileMonacoEditor } from './editor.tsx'
import type { FileMonacoEditorHandle } from './editor.tsx'
import type { FileEditTabParams } from './kind.ts'
import { languageFromPath } from './language.ts'
import { openFilePreview } from './open-tab.ts'
import type { FileEditNavigator } from './open-tab.ts'
import {
  agentEnhancerReadWorkspaceFile,
  agentEnhancerWriteWorkspaceFile,
} from './remote.ts'

export interface FileEditTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  readonly sidebarRight: FileEditNavigator | undefined
  readonly t: TranslateNS<'agent-enhancer'>
  /** Live settings bit for select-to-quote inside the editor. */
  readonly quoteEnabled?: () => boolean
}

type Phase = 'loading' | 'ready' | 'saving' | 'saved' | 'error'

function paramsOf(raw: unknown): Partial<FileEditTabParams> {
  if (raw === null || typeof raw !== 'object') return {}
  return raw as Partial<FileEditTabParams>
}

function resolveTarget(props: FileEditTabProps): {
  readonly sessionId: SessionId
  readonly path: string
  readonly address: string
} | undefined {
  const info = props.useTabInfo()
  const contentId = info.tab.contentId
  const fromAddress = parseWorkspaceFileAddress(contentId)
  if (fromAddress !== undefined) {
    return {
      sessionId: fromAddress.sessionId,
      path: fromAddress.path,
      address: contentId,
    }
  }
  const params = paramsOf(info.tab.navigation?.params)
  const sessionId = (typeof params.sessionId === 'string' && params.sessionId !== ''
    ? params.sessionId
    : props.sessionId) as SessionId
  const path = typeof params.path === 'string' ? params.path : ''
  if (path === '') return undefined
  return {
    sessionId,
    path,
    address: contentId,
  }
}

export function FileEditTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  const info = props.useTabInfo()
  const parsed = parseWorkspaceFileAddress(info.tab.contentId)
  const params = paramsOf(info.tab.navigation?.params)
  const path = parsed?.path
    ?? (typeof params.path === 'string' ? params.path : '')
  return (
    <span className={styles.fileEditTabTitle}>
      {path !== '' ? basenameOfPath(path) : props.t('fileEditTitle')}
    </span>
  )
}

export function FileEditTab(props: FileEditTabProps) {
  const target = resolveTarget(props)
  const sessionId = target?.sessionId
  const path = target?.path ?? ''
  const language = useMemo(() => languageFromPath(path), [path])

  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [phase, setPhase] = useState<Phase>('loading')
  const [message, setMessage] = useState(() => props.t('fileEditLoading'))
  const alive = useRef(true)
  const textRef = useRef('')
  const editorRef = useRef<FileMonacoEditorHandle | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadGeneration = useRef(0)
  textRef.current = text
  const dirty = text !== original
  const busy = phase === 'loading' || phase === 'saving'
  const editorReady = phase !== 'loading' || text !== ''

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    }
  }, [])

  const load = useCallback(async (signal: AbortSignal) => {
    const generation = ++loadGeneration.current
    if (sessionId === undefined || path === '') {
      setPhase('error')
      setMessage(props.t('fileEditNoPath'))
      return
    }
    const remote = props.remote()
    if (remote === undefined) {
      setPhase('error')
      setMessage(props.t('fileEditUnavailable'))
      return
    }
    setPhase('loading')
    setMessage(props.t('fileEditLoading'))
    try {
      const result = await agentEnhancerReadWorkspaceFile.invoke(
        remote,
        { sessionId, path },
        signal,
      )
      if (!alive.current || signal.aborted || generation !== loadGeneration.current) return
      setText(result.text)
      setOriginal(result.text)
      setPhase('ready')
      setMessage(props.t('fileEditReady', { lines: String(result.text.split('\n').length) }))
    } catch (error) {
      if (!alive.current || signal.aborted || generation !== loadGeneration.current) return
      setText('')
      setOriginal('')
      setPhase('error')
      if (error instanceof AuxiliaryError) {
        switch (error.code) {
          case 'FILE_TOO_LARGE':
            setMessage(props.t('fileEditTooLarge'))
            break
          case 'FILE_NOT_TEXT':
            setMessage(props.t('fileEditNotText'))
            break
          case 'FILE_DENIED':
            setMessage(props.t('fileEditDenied'))
            break
          case 'FILE_NOT_FOUND':
            setMessage(props.t('fileEditNotFound'))
            break
          case 'SESSION_CHANGED':
            setMessage(props.t('fileEditSessionChanged'))
            break
          default:
            setMessage(error.message || props.t('fileEditFailed'))
        }
      } else {
        setMessage(props.t('fileEditFailed'))
      }
    }
  }, [path, props, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const save = useCallback(async () => {
    if (sessionId === undefined || path === '' || phase === 'saving' || phase === 'loading') return
    const remote = props.remote()
    if (remote === undefined) {
      setPhase('error')
      setMessage(props.t('fileEditUnavailable'))
      return
    }
    setPhase('saving')
    setMessage(props.t('fileEditSaving'))
    try {
      await agentEnhancerWriteWorkspaceFile.invoke(
        remote,
        { sessionId, path, content: textRef.current },
      )
      if (!alive.current) return
      setOriginal(textRef.current)
      setPhase('saved')
      setMessage(props.t('fileEditSaved'))
    } catch (error) {
      if (!alive.current) return
      setPhase('error')
      if (error instanceof AuxiliaryError) {
        switch (error.code) {
          case 'FILE_DENIED':
            setMessage(props.t('fileEditDenied'))
            break
          case 'FILE_TOO_LARGE':
            setMessage(props.t('fileEditTooLarge'))
            break
          case 'SESSION_CHANGED':
            setMessage(props.t('fileEditSessionChanged'))
            break
          default:
            setMessage(error.message || props.t('fileEditSaveFailed'))
        }
      } else {
        setMessage(props.t('fileEditSaveFailed'))
      }
    }
  }, [path, phase, props, sessionId])

  useEffect(() => {
    if (!dirty || phase === 'saving' || phase === 'loading' || phase === 'error') return undefined
    if (saveTimer.current !== null) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void save()
    }, 1500)
    return () => {
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
    }
  }, [text, dirty, phase, save])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const statusClass = phase === 'error' ? styles.fileEditStatusError : styles.fileEditStatus

  return (
    <div className={styles.fileEditRoot}>
      <div className={styles.fileEditBar}>
        <span className={styles.fileEditPath} title={path}>{path || props.t('fileEditNoPath')}</span>
        <button
          type="button"
          className={dirty ? styles.fileEditBtnPrimary : styles.fileEditBtn}
          disabled={!dirty || busy}
          onClick={() => { void save() }}
          title={props.t('fileEditSaveHint')}
        >
          {phase === 'saving'
            ? props.t('fileEditSaving')
            : dirty
              ? props.t('fileEditSaveDirty')
              : props.t('fileEditSave')}
        </button>
        <button
          type="button"
          className={styles.fileEditBtn}
          disabled={!editorReady || phase === 'error'}
          onClick={() => editorRef.current?.openFind()}
          title={props.t('fileEditSearchHint')}
        >
          {props.t('fileEditSearch')}
        </button>
        <button
          type="button"
          className={styles.fileEditBtn}
          disabled={busy}
          onClick={() => { void load(new AbortController().signal) }}
          title={props.t('fileEditReloadHint')}
        >
          {props.t('fileEditReload')}
        </button>
        <button
          type="button"
          className={styles.fileEditBtn}
          disabled={sessionId === undefined || path === ''}
          onClick={() => {
            if (sessionId === undefined || path === '') return
            openFilePreview(props.sidebarRight, sessionId, path)
          }}
          title={props.t('fileEditPreviewHint')}
        >
          {props.t('fileEditPreview')}
        </button>
      </div>
      <div className={styles.fileEditHost}>
        {editorReady
          ? (
            <FileMonacoEditor
              ref={editorRef}
              value={text}
              language={language}
              onChange={setText}
              onSave={() => { void save() }}
              readOnly={phase === 'loading'}
              sessionId={sessionId}
              quoteLabel={props.t('quoteSelection')}
              quoteEnabled={props.quoteEnabled}
            />
          )
          : null}
        {phase === 'loading' && text === ''
          ? <div className={styles.fileEditLoading}>{props.t('fileEditLoading')}</div>
          : null}
      </div>
      <div className={statusClass} title={message}>{message}</div>
    </div>
  )
}
