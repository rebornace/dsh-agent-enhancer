/**
 * Skills manager — peer PluginManagerPage IA (list + Add sheet + detail).
 * Peer: `@deepseek-ai/dsh-client-ui-plugin-manager`.
 * Primary job: install into ~/.agents/skills (official discovery), then use Desktop `/`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GlobalStandardProps, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  Button,
  FileTypeIcon,
  IconCloseOutlineRegular,
  IconRefreshOutlineRegular,
  IconSkillOutlineRegular,
  Input,
  classifyFileType,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { AuxiliaryError } from '../../errors.ts'
import { skillScopeBucket } from '../../host/instructions-skills/scope.ts'
import type {
  InstructionsSkillsSnapshot,
  SkillCatalogEntry,
  SkillInstallChannelLabel,
} from '../../host/instructions-skills/types.ts'
import {
  ManagerAddSheet,
  ManagerDetail,
  ManagerPage,
  ManagerPageHead,
} from '../manager-shell.tsx'
import styles from '../styles.module.css'
import { scheduleOpenSkillDocument } from '../file-edit/open-tab.ts'
import type { FileEditNavigator } from '../file-edit/open-tab.ts'
import { instructionsSkillsErrorMessage } from './errors.ts'
import type { InstructionsSkillsTabParams } from './kind.ts'
import {
  agentEnhancerInstallSkillFromGit,
  agentEnhancerInstallSkillFromZip,
  agentEnhancerListInstructionsSkills,
  agentEnhancerReadSkillDocument,
  agentEnhancerUninstallSkill,
  agentEnhancerUpdateSkillFromGit,
} from './remote.ts'
import { setSkillsNavHasUpdates } from './nav-update-hints.ts'
import { SkillMarkdownPreview } from './markdown-preview.tsx'
import { SKILLS_PANEL_ID } from './kind.ts'
import './slot-types.ts'

export interface InstructionsSkillsPanelProps {
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  /** Live navigator — prefer a getter so main-panel mounts always see the host face. */
  readonly sidebarRight: FileEditNavigator | undefined | (() => FileEditNavigator | undefined)
  readonly t: TranslateNS<'agent-enhancer'>
  readonly sessionId?: SessionId
  readonly useTabInfo?: PropsRuntime<'sidebar.right.pane.tab'>['useTabInfo']
  readonly useSessions?: GlobalStandardProps['useSessions']
  /**
   * Leave the Skills main panel so Desktop can show the right sidebar.
   * Used only by “Open in sidebar” — in-panel preview stays while Skills is selected.
   */
  readonly onLeaveForPreview?: () => void
}

export type InstructionsSkillsTabProps = InstructionsSkillsPanelProps
  & PropsRuntime<'sidebar.right.pane.tab'>

export type InstructionsSkillsMainPanelProps = InstructionsSkillsPanelProps
  & PropsRuntime<'main', typeof SKILLS_PANEL_ID>

type ScopeFilter = 'all' | 'user' | 'project' | 'other'

function paramsOf(raw: unknown): InstructionsSkillsTabParams | null {
  if (raw === null || typeof raw !== 'object') return null
  const sessionId = Reflect.get(raw, 'sessionId')
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  return { sessionId }
}

function pickMainConversationSession(
  state: import('@deepseek-ai/dsh-api-session-controller/client').SessionListState,
): SessionId | undefined {
  for (const id of state.ids) {
    const row = state.byId[id]
    if (row !== undefined && (row.retainedBy.mainView ?? 0) > 0) return id
  }
  for (const row of Object.values(state.byId)) {
    if ((row.retainedBy.mainView ?? 0) > 0) return row.id
  }
  return undefined
}

function useInstructionsSkillsSessionId(props: InstructionsSkillsPanelProps): SessionId | undefined {
  const tabParams = props.useTabInfo === undefined
    ? null
    : paramsOf(props.useTabInfo().tab.navigation?.params)
  const fromMain = props.useSessions?.(pickMainConversationSession)
  if (typeof props.sessionId === 'string' && props.sessionId.trim() !== '') {
    return props.sessionId
  }
  if (tabParams !== null) {
    return tabParams.sessionId as SessionId
  }
  return fromMain
}

function channelLabelText(
  channel: SkillInstallChannelLabel | null,
  t: TranslateNS<'agent-enhancer'>,
): string | null {
  if (channel === null) return null
  switch (channel) {
    case 'github':
      return t('instructionsSkillsChannelGithub')
    case 'zip':
      return t('instructionsSkillsChannelZip')
    case 'unknown':
      return t('instructionsSkillsChannelUnknown')
    default: {
      const _exhaustive: never = channel
      return _exhaustive
    }
  }
}

/** UI guard: only GitHub ledger skills may show update chrome (host also enforces). */
export function skillShowsGitUpdate(entry: SkillCatalogEntry): boolean {
  if (!entry.updateAvailable) return false
  const channel = entry.installChannel
  if (channel === null) return false
  switch (channel) {
    case 'github':
      return true
    case 'zip':
    case 'unknown':
      return false
    default: {
      const _exhaustive: never = channel
      return _exhaustive
    }
  }
}

function skillSourceSubtitle(
  entry: SkillCatalogEntry,
  t: TranslateNS<'agent-enhancer'>,
): string {
  const channelText = channelLabelText(entry.installChannel, t)
  const source = entry.updateSourceLabel?.trim() ?? ''
  if (channelText !== null) {
    return source !== '' ? `${channelText} · ${source}` : channelText
  }
  return providerLabel(entry.provider, t)
}

function providerLabel(provider: string, t: TranslateNS<'agent-enhancer'>): string {
  switch (provider) {
    case 'shared':
      return t('instructionsSkillsProviderUser')
    case 'dsh-home':
      return t('instructionsSkillsProviderDsh')
    case 'project':
      return t('instructionsSkillsProviderProject')
    case 'project-dsh':
      return t('instructionsSkillsProviderProjectDsh')
    case 'registry':
      return t('instructionsSkillsProviderRegistry')
    case 'cursor':
      return t('instructionsSkillsProviderCursor')
    case 'cursor-builtin':
      return t('instructionsSkillsProviderCursorBuiltin')
    case 'codex':
      return t('instructionsSkillsProviderCodex')
    case 'claude':
      return t('instructionsSkillsProviderClaude')
    default:
      return provider
  }
}

function matchesQuery(entry: SkillCatalogEntry, query: string): boolean {
  if (query === '') return true
  const hay = `${entry.name}\n${entry.description}\n/${entry.name}`.toLowerCase()
  return hay.includes(query)
}

export function InstructionsSkillsMainPanel(props: InstructionsSkillsMainPanelProps) {
  return <InstructionsSkillsPanel {...props} />
}

/** @deprecated Right-pane guide removed; kept for narrow test / compat surfaces. */
export function InstructionsSkillsTab(props: InstructionsSkillsTabProps) {
  return <InstructionsSkillsPanel {...props} useTabInfo={props.useTabInfo} />
}

function resolveSidebarRight(
  sidebarRight: InstructionsSkillsPanelProps['sidebarRight'],
): FileEditNavigator | undefined {
  if (typeof sidebarRight === 'function') return sidebarRight()
  return sidebarRight
}

function InstructionsSkillsPanel(props: InstructionsSkillsPanelProps) {
  const sessionId = useInstructionsSkillsSessionId(props)
  const [snapshot, setSnapshot] = useState<InstructionsSkillsSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [addOpen, setAddOpen] = useState(false)
  const [gitSource, setGitSource] = useState('')
  const [installingName, setInstallingName] = useState<string | null>(null)
  const [installedQuery, setInstalledQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all')
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const [previewEntry, setPreviewEntry] = useState<SkillCatalogEntry | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const load = useCallback(async (signal: AbortSignal) => {
    if (sessionId === undefined) {
      setSnapshot(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const face = props.remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const next = await agentEnhancerListInstructionsSkills.invoke(face, { sessionId }, signal)
      if (signal.aborted) return
      setSnapshot(next)
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
      setSnapshot(null)
      setError(instructionsSkillsErrorMessage(err, props.t))
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [props, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, refreshToken])

  useEffect(() => {
    const skills = snapshot?.skills ?? []
    setSkillsNavHasUpdates(skills.some(entry => skillShowsGitUpdate(entry)))
  }, [snapshot])

  const refresh = () => {
    setNote(null)
    setConfirmUninstall(null)
    setRefreshToken(token => token + 1)
  }

  useEffect(() => {
    const path = previewEntry?.path ?? null
    if (previewEntry === null || sessionId === undefined || path === null) {
      setPreviewText(null)
      setPreviewError(null)
      setPreviewLoading(false)
      return
    }
    const controller = new AbortController()
    setPreviewLoading(true)
    setPreviewError(null)
    setPreviewText(null)
    void (async () => {
      try {
        const face = props.remote()
        if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
        const result = await agentEnhancerReadSkillDocument.invoke(
          face,
          { sessionId, path },
          controller.signal,
        )
        if (controller.signal.aborted) return
        setPreviewText(result.text)
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return
        setPreviewText(null)
        setPreviewError(instructionsSkillsErrorMessage(err, props.t))
      } finally {
        if (!controller.signal.aborted) setPreviewLoading(false)
      }
    })()
    return () => controller.abort()
  }, [previewEntry, props, sessionId])

  const installedSkills = useMemo(
    () => snapshot?.skills ?? [],
    [snapshot],
  )

  const queryNormalized = installedQuery.trim().toLowerCase()

  const filteredInstalled = useMemo(() => {
    return installedSkills.filter(entry => {
      if (scopeFilter !== 'all' && skillScopeBucket(entry.provider) !== scopeFilter) return false
      return matchesQuery(entry, queryNormalized)
    })
  }, [installedSkills, queryNormalized, scopeFilter])

  const groupedInstalled = useMemo(() => {
    const groups: { readonly bucket: Exclude<ScopeFilter, 'all'>, readonly items: SkillCatalogEntry[] }[] = [
      { bucket: 'user', items: [] },
      { bucket: 'project', items: [] },
      { bucket: 'other', items: [] },
    ]
    for (const entry of filteredInstalled) {
      const bucket = skillScopeBucket(entry.provider)
      groups.find(group => group.bucket === bucket)?.items.push(entry)
    }
    return groups.filter(group => group.items.length > 0)
  }, [filteredInstalled])

  const anyUpdateCheckFailed = useMemo(
    () => installedSkills.some(entry => entry.updateCheckFailed),
    [installedSkills],
  )

  const onOpenSkill = (entry: SkillCatalogEntry) => {
    if (entry.path === null || sessionId === undefined) return
    setPreviewEntry(entry)
    setConfirmUninstall(null)
  }

  const onOpenInSidebar = (entry: SkillCatalogEntry) => {
    if (entry.path === null || sessionId === undefined) return
    props.onLeaveForPreview?.()
    scheduleOpenSkillDocument({
      getSidebarRight: () => resolveSidebarRight(props.sidebarRight),
      sessionId,
      path: entry.path,
      cwd: snapshot?.cwd,
    })
  }

  const onInstallGit = async () => {
    if (sessionId === undefined) return
    const source = gitSource.trim()
    if (source === '') return
    setNote(null)
    setError(null)
    setBusy(true)
    setInstallingName('git')
    try {
      const face = props.remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const result = await agentEnhancerInstallSkillFromGit.invoke(
        face,
        { sessionId, source, target: 'user', force: true },
        new AbortController().signal,
      )
      setSnapshot(result.snapshot)
      setGitSource('')
      setNote(props.t('instructionsSkillsInstalledNote'))
      setAddOpen(false)
      refresh()
    } catch (err) {
      setError(instructionsSkillsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
      setInstallingName(null)
    }
  }

  const onInstallZip = async () => {
    if (sessionId === undefined) return
    setNote(null)
    setError(null)
    setBusy(true)
    setInstallingName('zip')
    try {
      const face = props.remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const result = await agentEnhancerInstallSkillFromZip.invoke(
        face,
        { sessionId, target: 'user', force: true },
        new AbortController().signal,
      )
      if (result.cancelled) return
      setSnapshot(result.snapshot)
      setNote(
        props.t('instructionsSkillsZipInstalledNote')
          .replace('{count}', String(result.installed.length)),
      )
      setAddOpen(false)
      refresh()
    } catch (err) {
      setError(instructionsSkillsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
      setInstallingName(null)
    }
  }

  const onUpdateFromGit = async (entry: SkillCatalogEntry) => {
    if (sessionId === undefined || !entry.updateAvailable) return
    setNote(null)
    setError(null)
    setBusy(true)
    setInstallingName(entry.name)
    try {
      const face = props.remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const result = await agentEnhancerUpdateSkillFromGit.invoke(
        face,
        { sessionId, name: entry.name },
        new AbortController().signal,
      )
      setSnapshot(result.snapshot)
      setNote(props.t('instructionsSkillsUpdatedNote').replace('{name}', entry.name))
    } catch (err) {
      setError(instructionsSkillsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
      setInstallingName(null)
    }
  }

  const onUninstall = async (entry: SkillCatalogEntry) => {
    if (sessionId === undefined || entry.path === null || !entry.removable) return
    setNote(null)
    setError(null)
    if (previewEntry?.id === entry.id) {
      setPreviewEntry(null)
      setPreviewText(null)
      setPreviewError(null)
    }
    setBusy(true)
    setInstallingName(entry.name)
    try {
      await new Promise<void>(resolve => {
        requestAnimationFrame(() => resolve())
      })
      const face = props.remote()
      if (face === undefined) throw new AuxiliaryError('FILE_EDIT_FAILED', 'unavailable')
      const result = await agentEnhancerUninstallSkill.invoke(
        face,
        { sessionId, name: entry.name, path: entry.path },
        new AbortController().signal,
      )
      setSnapshot(result.snapshot)
      setConfirmUninstall(null)
      setNote(props.t('instructionsSkillsUninstalledNote').replace('{name}', entry.name))
    } catch (err) {
      setError(instructionsSkillsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
      setInstallingName(null)
    }
  }

  const scopeLabel = (bucket: ScopeFilter): string => {
    switch (bucket) {
      case 'all':
        return props.t('instructionsSkillsFilterAll')
      case 'user':
        return props.t('instructionsSkillsFilterUser')
      case 'project':
        return props.t('instructionsSkillsFilterProject')
      case 'other':
        return props.t('instructionsSkillsFilterOther')
      default: {
        const _exhaustive: never = bucket
        return _exhaustive
      }
    }
  }

  const renderSkillCard = (entry: SkillCatalogEntry) => {
    const confirming = confirmUninstall === entry.name
    const canPreview = sessionId !== undefined && entry.path !== null && !busy
    const subtitle = skillSourceSubtitle(entry, props.t)
    return (
      <li key={entry.id} className={styles.managerCard}>
        <div className={styles.managerCardHead}>
          <span className={styles.managerCardIcon} aria-hidden>
            <FileTypeIcon kind={classifyFileType('SKILL.md')} size={22} />
          </span>
          <div className={styles.managerCardMain}>
            <button
              type="button"
              className={styles.managerCardOpen}
              disabled={!canPreview}
              title={entry.path ?? props.t('instructionsSkillsMissing')}
              onClick={() => onOpenSkill(entry)}
            >
              <span className={styles.managerCardTitle}>{entry.name}</span>
            </button>
            <span className={styles.managerCardDesc}>{subtitle}</span>
          </div>
          <div className={styles.managerCardEnd}>
            {skillShowsGitUpdate(entry) ? (
              <>
                <span className={styles.managerUpdatePill}>
                  {props.t('instructionsSkillsUpdateAvailable')}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => { void onUpdateFromGit(entry) }}
                >
                  {installingName === entry.name
                    ? props.t('instructionsSkillsUpdating')
                    : props.t('instructionsSkillsUpdate')}
                </Button>
              </>
            ) : null}
            {entry.removable ? (
              confirming ? (
                <div className={styles.managerConfirm}>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy}
                    onClick={() => { void onUninstall(entry) }}
                  >
                    {installingName === entry.name
                      ? props.t('instructionsSkillsUninstalling')
                      : props.t('instructionsSkillsUninstallConfirm')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmUninstall(null)}
                  >
                    {props.t('instructionsSkillsUninstallCancel')}
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.managerDeleteButton}
                  disabled={busy}
                  title={props.t('instructionsSkillsUninstallHint')}
                  aria-label={props.t('instructionsSkillsUninstall')}
                  onClick={() => setConfirmUninstall(entry.name)}
                >
                  <IconCloseOutlineRegular size={16} />
                </button>
              )
            ) : null}
          </div>
        </div>
      </li>
    )
  }

  const sessionBlocked = sessionId === undefined

  if (previewEntry !== null) {
    return (
      <ManagerPage data-state={sessionBlocked ? 'no-session' : 'tree'}>
        {error !== null ? <div className={styles.managerFailure} role="alert">{error}</div> : null}
        {note !== null ? <p className={styles.managerBanner}>{note}</p> : null}
        <ManagerDetail
          crumbLabel={props.t('instructionsSkillsTitle')}
          onBack={() => setPreviewEntry(null)}
          title={previewEntry.name}
          description={skillSourceSubtitle(previewEntry, props.t)}
          actions={(
            <>
              {props.onLeaveForPreview !== undefined ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || previewEntry.path === null}
                  title={props.t('instructionsSkillsOpenInSidebarHint')}
                  onClick={() => onOpenInSidebar(previewEntry)}
                >
                  {props.t('instructionsSkillsOpenInSidebar')}
                </Button>
              ) : null}
              {skillShowsGitUpdate(previewEntry) ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => { void onUpdateFromGit(previewEntry) }}
                >
                  {installingName === previewEntry.name
                    ? props.t('instructionsSkillsUpdating')
                    : props.t('instructionsSkillsUpdate')}
                </Button>
              ) : null}
            </>
          )}
        >
          <div className={styles.managerDetailSection}>
            {previewLoading ? (
              <p className={styles.managerStatus}>{props.t('instructionsSkillsPreviewLoading')}</p>
            ) : null}
            {previewError !== null ? (
              <div className={styles.managerFailure} role="alert">{previewError}</div>
            ) : null}
            {previewText !== null ? (
              <SkillMarkdownPreview text={previewText} t={props.t} />
            ) : null}
          </div>
        </ManagerDetail>
      </ManagerPage>
    )
  }

  return (
    <ManagerPage data-state={sessionBlocked ? 'no-session' : 'tree'}>
      <ManagerPageHead
        title={props.t('instructionsSkillsTitle')}
        intro={props.t('instructionsSkillsIntro')}
        toolbar={(
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || busy || sessionBlocked}
              onClick={refresh}
            >
              <IconRefreshOutlineRegular size={16} />
              {' '}
              {props.t('instructionsSkillsRefresh')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || sessionBlocked}
              onClick={() => {
                setAddOpen(true)
                setConfirmUninstall(null)
                setError(null)
              }}
            >
              {props.t('instructionsSkillsAdd')}
            </Button>
          </>
        )}
      />

      {error !== null ? <div className={styles.managerFailure} role="alert">{error}</div> : null}
      {!sessionBlocked && anyUpdateCheckFailed ? (
        <p className={styles.managerBanner} role="status">
          {props.t('instructionsSkillsUpdateCheckFailed')}
        </p>
      ) : null}
      {note !== null ? <p className={styles.managerBanner}>{note}</p> : null}

      {sessionBlocked ? (
        <p className={styles.managerStatus}>{props.t('instructionsSkillsNoSession')}</p>
      ) : loading && snapshot === null ? (
        <p className={styles.managerStatus}>{props.t('instructionsSkillsLoading')}</p>
      ) : installedSkills.length === 0 ? (
        <div className={styles.managerEmptyBlock}>
          <p className={styles.managerEmpty}>{props.t('instructionsSkillsInstalledEmpty')}</p>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => setAddOpen(true)}
          >
            {props.t('instructionsSkillsAdd')}
          </Button>
        </div>
      ) : (
        <>
          <div className={styles.managerToolbar}>
            <Input
              className={styles.managerSearch}
              value={installedQuery}
              disabled={busy}
              placeholder={props.t('instructionsSkillsSearchPlaceholder')}
              aria-label={props.t('instructionsSkillsSearch')}
              onChange={event => setInstalledQuery(event.target.value)}
            />
            <select
              className={styles.managerScopeSelect}
              value={scopeFilter}
              disabled={busy}
              aria-label={props.t('instructionsSkillsFilter')}
              onChange={event => {
                setScopeFilter(event.target.value as ScopeFilter)
                setConfirmUninstall(null)
              }}
            >
              <option value="all">{scopeLabel('all')}</option>
              <option value="user">{scopeLabel('user')}</option>
              <option value="project">{scopeLabel('project')}</option>
              <option value="other">{scopeLabel('other')}</option>
            </select>
          </div>

          {filteredInstalled.length === 0 ? (
            <p className={styles.managerEmpty}>{props.t('instructionsSkillsSearchEmpty')}</p>
          ) : scopeFilter === 'all' ? (
            groupedInstalled.map(group => (
              <div key={group.bucket} className={styles.managerGroup}>
                <p className={styles.managerGroupTitle}>
                  {scopeLabel(group.bucket)}
                  {' · '}
                  {group.items.length}
                </p>
                <ul className={styles.managerCards}>
                  {group.items.map(renderSkillCard)}
                </ul>
              </div>
            ))
          ) : (
            <ul className={styles.managerCards}>
              {filteredInstalled.map(renderSkillCard)}
            </ul>
          )}
        </>
      )}

      <ManagerAddSheet
        open={addOpen}
        title={props.t('instructionsSkillsAdd')}
        closeLabel={props.t('instructionsSkillsUninstallCancel')}
        onClose={() => setAddOpen(false)}
        footer={(
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setAddOpen(false)}
          >
            {props.t('instructionsSkillsUninstallCancel')}
          </Button>
        )}
      >
        <label className={styles.managerField}>
          <span className={styles.managerFieldLabel}>{props.t('instructionsSkillsInstallGit')}</span>
          <div className={styles.managerFormRow}>
            <Input
              value={gitSource}
              disabled={busy}
              placeholder={props.t('instructionsSkillsInstallGitPlaceholder')}
              onChange={event => setGitSource(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void onInstallGit()
                }
              }}
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || gitSource.trim() === ''}
              onClick={() => { void onInstallGit() }}
            >
              {installingName === 'git'
                ? props.t('instructionsSkillsInstalling')
                : props.t('instructionsSkillsInstall')}
            </Button>
          </div>
        </label>
        <label className={styles.managerField}>
          <span className={styles.managerFieldLabel}>{props.t('instructionsSkillsInstallZip')}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => { void onInstallZip() }}
          >
            {installingName === 'zip'
              ? props.t('instructionsSkillsInstalling')
              : props.t('instructionsSkillsInstallZip')}
          </Button>
        </label>
      </ManagerAddSheet>
    </ManagerPage>
  )
}

export function InstructionsSkillsTabTitle(props: PropsRuntime<'sidebar.right.pane.tab.title'> & {
  readonly t: TranslateNS<'agent-enhancer'>
}) {
  return (
    <>
      <IconSkillOutlineRegular size={16} className={styles.instructionsSkillsTitleIcon} />
      <span>{props.t('instructionsSkillsTitle')}</span>
    </>
  )
}
