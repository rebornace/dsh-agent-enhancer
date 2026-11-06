import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  FileTypeIcon,
  IconCloseOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconPlusOutlineRegular,
  PathLabel,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AuxiliaryError } from '../../errors.ts'
import type {
  ExtraFolderEntry,
  ExtraFolderRoot,
  ListExtraFoldersResult,
} from '../../host/extra-folders/types.ts'
import styles from '../styles.module.css'
import { openWorkspaceFile } from '../file-edit/open-tab.ts'
import type { FileEditNavigator } from '../file-edit/open-tab.ts'
import { EXTRA_FOLDERS_TAB_KIND } from './kind.ts'
import type { ExtraFoldersTabParams } from './kind.ts'
import {
  agentEnhancerListExtraFolderEntries,
  agentEnhancerListExtraFolders,
  agentEnhancerPickExtraFolder,
  agentEnhancerRemoveExtraFolder,
} from './remote.ts'

export interface ExtraFoldersTabProps extends PropsRuntime<'sidebar.right.pane.tab'> {
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  readonly sidebarRight: FileEditNavigator | undefined
  readonly t: TranslateNS<'agent-enhancer'>
}

type Phase = 'booting' | 'picking' | 'ready' | 'error'

type BootResult =
  | { readonly kind: 'ready', readonly snapshot: ListExtraFoldersResult }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error', readonly message: string }

interface TreeNodeState {
  readonly expanded: boolean
  readonly loading: boolean
  readonly error: string | null
  readonly entries: readonly ExtraFolderEntry[] | null
}

/** Deduplicate Strict Mode remounts so the native picker opens once per boot. */
const bootInflight = new Map<string, Promise<BootResult>>()

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function orderEntries(entries: readonly ExtraFolderEntry[]): readonly ExtraFolderEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.kind === 'directory') - Number(left.kind === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

function paramsOf(raw: unknown): ExtraFoldersTabParams | null {
  if (raw === null || typeof raw !== 'object') return null
  const sessionId = Reflect.get(raw, 'sessionId')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  return { sessionId }
}

/** Prefer the live session-scoped slot id (same rule as checkpoint timeline). */
function resolveSessionId(
  scopedSessionId: string | undefined,
  params: ExtraFoldersTabParams | null,
): SessionId | undefined {
  if (typeof scopedSessionId === 'string' && scopedSessionId.trim() !== '') {
    return scopedSessionId as SessionId
  }
  return params?.sessionId as SessionId | undefined
}

function errorMessage(error: unknown, t: TranslateNS<'agent-enhancer'>): string {
  if (error instanceof AuxiliaryError) {
    switch (error.code) {
      case 'SESSION_CHANGED':
        return t('extraFoldersSessionChanged')
      case 'FILE_NOT_FOUND':
        return t('extraFoldersNotFound')
      case 'FILE_DENIED':
        return t('extraFoldersDenied')
      default:
        return error.message || t('extraFoldersFailed')
    }
  }
  return error instanceof Error ? error.message : t('extraFoldersFailed')
}

async function bootExtraFolders(
  sessionId: SessionId,
  remote: () => { readonly agentEnhancer: object } | undefined,
  t: TranslateNS<'agent-enhancer'>,
  onWillPick?: () => void,
): Promise<BootResult> {
  const existing = bootInflight.get(sessionId)
  if (existing !== undefined) {
    onWillPick?.()
    return existing
  }

  const run = (async (): Promise<BootResult> => {
    try {
      const face = remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const listed = await agentEnhancerListExtraFolders.invoke(
        face,
        { sessionId },
        new AbortController().signal,
      )
      if (listed.roots.length > 0) {
        return { kind: 'ready', snapshot: listed }
      }
      onWillPick?.()
      const faceAgain = remote()
      if (faceAgain === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const picked = await agentEnhancerPickExtraFolder.invoke(
        faceAgain,
        { sessionId },
        new AbortController().signal,
      )
      if (!picked.added) return { kind: 'cancelled' }
      return {
        kind: 'ready',
        snapshot: {
          primaryCwd: picked.primaryCwd,
          primaryTitle: picked.primaryTitle,
          roots: picked.roots,
        },
      }
    } catch (error) {
      return { kind: 'error', message: errorMessage(error, t) }
    }
  })()

  bootInflight.set(sessionId, run)
  try {
    return await run
  } finally {
    if (bootInflight.get(sessionId) === run) bootInflight.delete(sessionId)
  }
}

/**
 * Directory / file rows mirror `@deepseek-ai/dsh-client-ui-sidebar-files` Entry:
 * folder open/close glyphs + FileTypeIcon(classifyFileType(name)).
 */
function FolderTree(props: {
  readonly sessionId: SessionId
  readonly rootPath: string
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  readonly sidebarRight: FileEditNavigator | undefined
  readonly t: TranslateNS<'agent-enhancer'>
  readonly relativePath?: string
  readonly label: string
  readonly removable?: boolean
  readonly onRemove?: () => void
  readonly defaultExpanded?: boolean
}) {
  const [node, setNode] = useState<TreeNodeState>({
    expanded: props.defaultExpanded === true,
    loading: false,
    error: null,
    entries: null,
  })
  const relativePath = props.relativePath ?? ''
  const remote = props.remote
  const t = props.t
  const sessionId = props.sessionId
  const rootPath = props.rootPath

  const load = useCallback(async () => {
    const face = remote()
    if (face === undefined) {
      setNode(prev => ({ ...prev, loading: false, error: t('extraFoldersUnavailable') }))
      return
    }
    setNode(prev => ({ ...prev, loading: true, error: null }))
    try {
      const result = await agentEnhancerListExtraFolderEntries.invoke(face, {
        sessionId,
        rootPath,
        relativePath: relativePath === '' ? undefined : relativePath,
      }, new AbortController().signal)
      setNode({
        expanded: true,
        loading: false,
        error: null,
        entries: orderEntries(result.entries),
      })
    } catch (error) {
      setNode(prev => ({
        ...prev,
        loading: false,
        error: errorMessage(error, t),
        entries: prev.entries,
      }))
    }
  }, [remote, t, sessionId, rootPath, relativePath])

  useEffect(() => {
    if (props.defaultExpanded === true && node.entries === null && !node.loading) {
      void load()
    }
  }, [props.defaultExpanded, node.entries, node.loading, load])

  const toggle = () => {
    if (node.expanded) {
      setNode(prev => ({ ...prev, expanded: false }))
      return
    }
    if (node.entries === null) void load()
    else setNode(prev => ({ ...prev, expanded: true }))
  }

  const FolderGlyph = node.expanded ? IconFolderOpenRegular : IconFolderCloseRegular

  return (
    <li className={styles.extraFoldersItem} data-extra-folders-entry="directory">
      <div className={styles.extraFoldersRowWrap}>
        <button
          type="button"
          className={styles.extraFoldersRow}
          aria-expanded={node.expanded}
          onClick={toggle}
          title={props.rootPath}
        >
          <FolderGlyph className={styles.extraFoldersFolderIcon} />
          <span className={styles.extraFoldersName}>{props.label}</span>
        </button>
        {props.removable === true && props.onRemove !== undefined ? (
          <button
            type="button"
            className={styles.extraFoldersRemove}
            onClick={props.onRemove}
            title={props.t('extraFoldersRemoveHint')}
            aria-label={props.t('extraFoldersRemove')}
          >
            <IconCloseOutlineRegular />
          </button>
        ) : null}
      </div>
      {node.expanded ? (
        <ul className={styles.extraFoldersLevel}>
          {node.loading && node.entries === null ? (
            <li className={styles.extraFoldersNote}>{props.t('extraFoldersLoading')}</li>
          ) : null}
          {node.error !== null ? (
            <li className={styles.extraFoldersNote}>{node.error}</li>
          ) : null}
          {node.entries !== null && node.entries.length === 0 ? (
            <li className={styles.extraFoldersNote}>{props.t('extraFoldersEmptyDir')}</li>
          ) : null}
          {node.entries?.map(entry => (
            entry.kind === 'directory' ? (
              <FolderTree
                key={entry.absolutePath}
                sessionId={props.sessionId}
                rootPath={props.rootPath}
                remote={props.remote}
                sidebarRight={props.sidebarRight}
                t={props.t}
                relativePath={entry.path}
                label={entry.name}
              />
            ) : (
              <li
                key={entry.absolutePath}
                className={styles.extraFoldersItem}
                data-extra-folders-entry="file"
              >
                <button
                  type="button"
                  className={styles.extraFoldersRow}
                  title={entry.absolutePath}
                  onClick={() => openWorkspaceFile(props.sidebarRight, props.sessionId, entry.absolutePath)}
                >
                  <FileTypeIcon
                    kind={classifyFileType(entry.name)}
                    size={16}
                    className={styles.extraFoldersFileIcon}
                  />
                  <span className={styles.extraFoldersName}>{entry.name}</span>
                </button>
              </li>
            )
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function ExtraFoldersTab(props: ExtraFoldersTabProps) {
  const info = props.useTabInfo()
  const params = paramsOf(info.tab.navigation?.params)
  const sessionId = resolveSessionId(
    typeof props.sessionId === 'string' ? props.sessionId : undefined,
    params,
  )
  const [phase, setPhase] = useState<Phase>('booting')
  const [error, setError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ListExtraFoldersResult | null>(null)
  const [busy, setBusy] = useState(false)
  const remote = props.remote
  const t = props.t
  const closeTab = info.tab.actions.close

  useEffect(() => {
    if (sessionId === undefined) return
    let cancelled = false
    setPhase('booting')
    setError(null)
    void (async () => {
      const result = await bootExtraFolders(sessionId, remote, t, () => {
        if (!cancelled) setPhase('picking')
      })
      if (cancelled) return
      switch (result.kind) {
        case 'ready':
          setSnapshot(result.snapshot)
          setPhase('ready')
          return
        case 'cancelled':
          try {
            closeTab()
          } catch {
            // Guide may already have replaced this occurrence.
          }
          return
        case 'error':
          setError(result.message)
          setPhase('error')
          return
        default: {
          const _exhaustive: never = result
          return _exhaustive
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, remote, t, closeTab])

  const pickFolder = useCallback(async () => {
    if (sessionId === undefined || busy) return
    setBusy(true)
    setError(null)
    setPhase('picking')
    try {
      const face = remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const next = await agentEnhancerPickExtraFolder.invoke(
        face,
        { sessionId },
        new AbortController().signal,
      )
      if (!next.added) {
        setPhase('ready')
        return
      }
      setSnapshot({
        primaryCwd: next.primaryCwd,
        primaryTitle: next.primaryTitle,
        roots: next.roots,
      })
      setPhase('ready')
    } catch (err) {
      setError(errorMessage(err, t))
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }, [busy, remote, sessionId, t])

  const removeFolder = async (root: ExtraFolderRoot) => {
    if (sessionId === undefined || busy) return
    setBusy(true)
    setError(null)
    try {
      const face = remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const next = await agentEnhancerRemoveExtraFolder.invoke(
        face,
        { sessionId, path: root.path },
        new AbortController().signal,
      )
      setSnapshot(next)
      setPhase('ready')
    } catch (err) {
      setError(errorMessage(err, t))
      setPhase('error')
    } finally {
      setBusy(false)
    }
  }

  const roots = useMemo(() => snapshot?.roots ?? [], [snapshot])
  const headerPath = roots.length === 1 ? roots[0]?.path : undefined

  if (sessionId === undefined) {
    return (
      <div className={styles.extraFoldersStatus} data-extra-folders-state="no-session">
        <p className={styles.extraFoldersStatusLine}>{t('extraFoldersNoSession')}</p>
      </div>
    )
  }

  if (phase === 'booting' || phase === 'picking') {
    return (
      <div className={styles.extraFoldersStatus} data-extra-folders-state={phase}>
        <p className={styles.extraFoldersStatusLine}>
          {phase === 'picking' ? t('extraFoldersPicking') : t('extraFoldersLoading')}
        </p>
      </div>
    )
  }

  return (
    <div className={styles.extraFoldersPane} data-extra-folders-state="tree">
      <div className={styles.extraFoldersHeader}>
        {headerPath !== undefined ? (
          <PathLabel path={headerPath} className={styles.extraFoldersPath} />
        ) : (
          <span className={styles.extraFoldersPath}>{t('extraFoldersTitle')}</span>
        )}
        <button
          type="button"
          className={styles.extraFoldersTool}
          onClick={() => void pickFolder()}
          disabled={busy}
          title={t('extraFoldersAddHint')}
          aria-label={t('extraFoldersAdd')}
        >
          <IconPlusOutlineRegular />
        </button>
      </div>
      {error !== null ? <div className={styles.extraFoldersError}>{error}</div> : null}
      <div className={styles.extraFoldersBody}>
        {roots.length === 0 ? (
          <ul className={styles.extraFoldersLevel}>
            <li className={styles.extraFoldersNote}>{t('extraFoldersNone')}</li>
            <li className={styles.extraFoldersItem}>
              <button
                type="button"
                className={styles.extraFoldersRow}
                onClick={() => void pickFolder()}
              >
                <IconPlusOutlineRegular className={styles.extraFoldersFolderIcon} />
                <span className={styles.extraFoldersName}>{t('extraFoldersAdd')}</span>
              </button>
            </li>
          </ul>
        ) : (
          <ul className={styles.extraFoldersLevel}>
            {roots.map(root => (
              <FolderTree
                key={root.path}
                sessionId={sessionId}
                rootPath={root.path}
                remote={remote}
                sidebarRight={props.sidebarRight}
                t={t}
                label={root.title}
                defaultExpanded
                removable
                onRemove={() => void removeFolder(root)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function ExtraFoldersTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  return (
    <>
      <FileTypeIcon kind="folder" size={16} className={styles.extraFoldersTitleIcon} />
      <span>{props.t('extraFoldersTitle')}</span>
    </>
  )
}

export { EXTRA_FOLDERS_TAB_KIND }
