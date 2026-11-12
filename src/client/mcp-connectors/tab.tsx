/**
 * MCP connectors — peer PluginManagerPage IA (list + Switch + Add sheet + detail).
 * Peer: `@deepseek-ai/dsh-client-ui-plugin-manager`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  IconCloseOutlineRegular,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular,
  Switch,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  McpConnectorEntry,
  McpConnectorRuntimeStatus,
  McpConnectorStatusState,
  McpConnectorToolInfo,
  McpConnectorsSnapshot,
  McpTransport,
} from '../../host/mcp-connectors/types.ts'
import {
  ManagerAddSheet,
  ManagerDetail,
  ManagerPage,
  ManagerPageHead,
} from '../manager-shell.tsx'
import styles from '../styles.module.css'
import { mcpConnectorsErrorMessage } from './errors.ts'
import type { MCP_CONNECTORS_PANEL_ID } from './kind.ts'
import {
  agentEnhancerImportMcpJson,
  agentEnhancerListMcpConnectorTools,
  agentEnhancerListMcpConnectors,
  agentEnhancerProbeMcpConnector,
  agentEnhancerRestartMcpConnector,
  agentEnhancerSetMcpConnectorEnabled,
  agentEnhancerUninstallMcpConnector,
} from './remote.ts'

export interface McpConnectorsPanelProps {
  readonly remote: () => { readonly agentEnhancer: object } | undefined
  readonly t: TranslateNS<'agent-enhancer'>
}

export type McpConnectorsMainPanelProps =
  & PropsRuntime<'main', typeof MCP_CONNECTORS_PANEL_ID>
  & McpConnectorsPanelProps

const DEFAULT_MCP_JSON = `{
  "mcpServers": {
    "example-stdio": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    },
    "example-remote": {
      "url": "https://example.com/mcp"
    }
  }
}`

function transportLabel(
  transport: McpTransport,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (transport) {
    case 'stdio':
      return t('mcpConnectorsTransportStdio')
    case 'streamable-http':
      return t('mcpConnectorsTransportRemote')
    default: {
      const _exhaustive: never = transport
      return _exhaustive
    }
  }
}

function entrySubtitle(entry: McpConnectorEntry, t: TranslateNS<'agent-enhancer'>): string {
  const kind = transportLabel(entry.transport.transport, t)
  if (entry.transport.transport === 'stdio') {
    const cmd = [entry.transport.command, ...entry.transport.args].join(' ').trim()
    return cmd === '' ? kind : `${kind} · ${cmd}`
  }
  return `${kind} · ${entry.transport.url}`
}

function statusLabel(
  state: McpConnectorStatusState,
  t: TranslateNS<'agent-enhancer'>,
): string {
  switch (state) {
    case 'disabled':
      return t('mcpConnectorsStatus_disabled')
    case 'unmounted':
      return t('mcpConnectorsStatus_unmounted')
    case 'connecting':
      return t('mcpConnectorsStatus_connecting')
    case 'connected':
      return t('mcpConnectorsStatus_connected')
    case 'reconnecting':
      return t('mcpConnectorsStatus_reconnecting')
    case 'waiting-credentials':
      return t('mcpConnectorsStatus_waiting-credentials')
    case 'failed':
      return t('mcpConnectorsStatus_failed')
    case 'closed':
      return t('mcpConnectorsStatus_closed')
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function statusOf(
  snapshot: McpConnectorsSnapshot | null,
  id: string,
): McpConnectorRuntimeStatus | null {
  return snapshot?.statuses.find(row => row.id === id)?.status ?? null
}

function formatStatusLine(
  status: McpConnectorRuntimeStatus | null,
  t: TranslateNS<'agent-enhancer'>,
): string {
  if (status === null) return t('mcpConnectorsStatus_unmounted')
  const base = statusLabel(status.state, t)
  const bits = [base]
  if (typeof status.toolCount === 'number') bits.push(`${status.toolCount} tools`)
  if (status.detail !== null && status.detail.trim() !== '') bits.push(status.detail.trim())
  return bits.join(' · ')
}

function probeToastCopy(
  result: { readonly ok: boolean; readonly message: string },
  t: TranslateNS<'agent-enhancer'>,
): { readonly text: string; readonly tone?: 'success' } {
  if (result.ok) {
    return {
      text: `${t('mcpConnectorsProbeOk')} · ${result.message}`,
      tone: 'success',
    }
  }
  const detail = result.message === 'url-expired'
    ? t('mcpConnectorsProbeUrlExpired')
    : result.message
  return { text: `${t('mcpConnectorsProbeFailed')} · ${detail}` }
}

interface ManagerToast {
  readonly key: number
  readonly text: string
  readonly tone?: 'success'
}

export function McpConnectorsMainPanel(props: McpConnectorsMainPanelProps) {
  return <McpConnectorsPanel {...props} />
}

function McpConnectorsPanel(props: McpConnectorsPanelProps) {
  const [snapshot, setSnapshot] = useState<McpConnectorsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<ManagerToast | null>(null)
  const toastSeq = useRef(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [tools, setTools] = useState<readonly McpConnectorToolInfo[]>([])
  const [toolsLoading, setToolsLoading] = useState(false)
  const [jsonText, setJsonText] = useState(DEFAULT_MCP_JSON)
  const [force, setForce] = useState(true)

  const showToast = useCallback((text: string, tone?: 'success') => {
    toastSeq.current += 1
    setToast({ key: toastSeq.current, text, ...(tone === undefined ? {} : { tone }) })
  }, [])

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const remote = props.remote()
      const next = await agentEnhancerListMcpConnectors.invoke(remote, signal)
      if (signal?.aborted) return
      setSnapshot(next)
    } catch (err) {
      if (signal?.aborted) return
      setError(mcpConnectorsErrorMessage(err, props.t))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [props])

  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const selected = snapshot?.connectors.find(entry => entry.id === selectedId) ?? null

  useEffect(() => {
    if (selected === null || !selected.enabled) {
      setTools([])
      return
    }
    const controller = new AbortController()
    setToolsLoading(true)
    void agentEnhancerListMcpConnectorTools
      .invoke(props.remote(), { serverName: selected.serverName }, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) setTools(result.tools)
      })
      .catch(() => {
        if (!controller.signal.aborted) setTools([])
      })
      .finally(() => {
        if (!controller.signal.aborted) setToolsLoading(false)
      })
    return () => controller.abort()
  }, [selected, props])

  const applySnapshot = (next: McpConnectorsSnapshot) => {
    setSnapshot(next)
  }

  const onToggle = async (entry: McpConnectorEntry, enabled: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const result = await agentEnhancerSetMcpConnectorEnabled.invoke(
        props.remote(),
        { id: entry.id, enabled },
      )
      applySnapshot(result.snapshot)
    } catch (err) {
      showToast(mcpConnectorsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
    }
  }

  const onUninstall = async (entry: McpConnectorEntry) => {
    setBusy(true)
    setError(null)
    try {
      const result = await agentEnhancerUninstallMcpConnector.invoke(
        props.remote(),
        { id: entry.id },
      )
      applySnapshot(result.snapshot)
      setConfirmId(null)
      if (selectedId === entry.id) setSelectedId(null)
      showToast(
        props.t('mcpConnectorsUninstalledNote').replace('{name}', entry.serverName),
        'success',
      )
    } catch (err) {
      showToast(mcpConnectorsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
    }
  }

  const onImportJson = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await agentEnhancerImportMcpJson.invoke(props.remote(), {
        jsonText,
        force,
      })
      applySnapshot(result.snapshot)
      setAddOpen(false)
      if (result.imported.length > 0) {
        setSelectedId(result.imported[0]!.id)
      }
      showToast(
        props.t('mcpConnectorsImportedNote').replace('{count}', String(result.imported.length)),
        'success',
      )
    } catch (err) {
      showToast(mcpConnectorsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
    }
  }

  const connectors = snapshot?.connectors ?? []
  const canSubmitImport = jsonText.trim() !== ''
  const selectedStatus = selected === null ? null : statusOf(snapshot, selected.id)

  const onRestart = async (entry: McpConnectorEntry) => {
    setBusy(true)
    setError(null)
    try {
      const remote = props.remote()
      const result = await agentEnhancerRestartMcpConnector.invoke(remote, { id: entry.id })
      setSnapshot(result.snapshot)
      if (result.ok) {
        showToast(props.t('mcpConnectorsRestartOk'), 'success')
      } else {
        showToast(
          `${props.t('mcpConnectorsRestartFailed')}${result.error ? ` · ${result.error}` : ''}`,
        )
      }
    } catch (err) {
      showToast(mcpConnectorsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
    }
  }

  const onProbe = async (entry: McpConnectorEntry) => {
    setBusy(true)
    setError(null)
    try {
      const remote = props.remote()
      const result = await agentEnhancerProbeMcpConnector.invoke(remote, { id: entry.id })
      setSnapshot(result.snapshot)
      const copy = probeToastCopy(result, props.t)
      showToast(copy.text, copy.tone)
    } catch (err) {
      showToast(mcpConnectorsErrorMessage(err, props.t))
    } finally {
      setBusy(false)
    }
  }

  const toastNode = toast === null
    ? null
    : (
      <Toast
        key={toast.key}
        text={toast.text}
        tone={toast.tone}
        holdMs={toast.tone === 'success' ? 2800 : 5200}
        onDone={() => {
          setToast(current => (current?.key === toast.key ? null : current))
        }}
      />
    )

  if (selected !== null) {
    return (
      <ManagerPage data-state={loading ? 'loading' : 'ready'}>
        {toastNode}
        <ManagerDetail
          crumbLabel={props.t('mcpConnectorsTitle')}
          onBack={() => {
            setSelectedId(null)
            setConfirmId(null)
          }}
          title={selected.serverName}
          description={entrySubtitle(selected, props.t)}
          actions={(
            <>
              <Switch
                checked={selected.enabled}
                disabled={busy}
                label={selected.enabled
                  ? props.t('mcpConnectorsEnabled')
                  : props.t('mcpConnectorsDisabled')}
                onChange={next => {
                  void onToggle(selected, next)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !selected.enabled}
                onClick={() => { void onRestart(selected) }}
              >
                {busy ? props.t('mcpConnectorsRestarting') : props.t('mcpConnectorsRestart')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => { void onProbe(selected) }}
              >
                {busy ? props.t('mcpConnectorsProbing') : props.t('mcpConnectorsProbe')}
              </Button>
              {confirmId === selected.id ? (
                <div className={styles.managerConfirm}>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => { void onUninstall(selected) }}
                  >
                    {busy
                      ? props.t('mcpConnectorsUninstalling')
                      : props.t('mcpConnectorsUninstallConfirm')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirmId(null)}
                  >
                    {props.t('mcpConnectorsUninstallCancel')}
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  className={styles.managerDeleteButton}
                  title={props.t('mcpConnectorsUninstallHint')}
                  aria-label={props.t('mcpConnectorsUninstall')}
                  disabled={busy}
                  onClick={() => setConfirmId(selected.id)}
                >
                  <IconCloseOutlineRegular size={16} />
                </button>
              )}
            </>
          )}
        >
          <div className={styles.managerDetailSection}>
            <h3 className={styles.managerSectionTitle}>{props.t('mcpConnectorsStatus')}</h3>
            <p className={styles.managerStatus}>{formatStatusLine(selectedStatus, props.t)}</p>
          </div>
          <div className={styles.managerDetailSection}>
            <h3 className={styles.managerSectionTitle}>{props.t('mcpConnectorsToolsTitle')}</h3>
            {toolsLoading ? (
              <p className={styles.managerStatus}>{props.t('mcpConnectorsToolsLoading')}</p>
            ) : tools.length === 0 ? (
              <p className={styles.managerStatus}>
                {selected.enabled
                  ? props.t('mcpConnectorsToolsEmpty')
                  : props.t('mcpConnectorsToolsDisabled')}
              </p>
            ) : (
              <ul className={styles.managerRows}>
                {tools.map(tool => (
                  <li key={tool.name} className={styles.managerRow}>
                    <div className={styles.managerRowMain}>
                      <span className={styles.managerRowId}>{tool.name}</span>
                      {tool.description !== '' ? (
                        <span className={styles.managerRowMeta}>{tool.description}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ManagerDetail>
      </ManagerPage>
    )
  }

  return (
    <ManagerPage data-state={loading ? 'loading' : 'ready'}>
      {toastNode}
      <ManagerPageHead
        title={props.t('mcpConnectorsTitle')}
        intro={props.t('mcpConnectorsIntro')}
        toolbar={(
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || loading}
              onClick={() => { void refresh() }}
            >
              <IconRefreshOutlineRegular size={16} />
              {' '}
              {props.t('mcpConnectorsRefresh')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                setAddOpen(true)
                setConfirmId(null)
                setError(null)
              }}
            >
              {props.t('mcpConnectorsAdd')}
            </Button>
          </>
        )}
      />

      {snapshot !== null && !snapshot.bridgeAvailable ? (
        <p className={styles.managerBanner} role="status">
          {props.t('mcpConnectorsBridgeMissing')}
          {snapshot.bridgeError !== null ? ` (${snapshot.bridgeError})` : ''}
        </p>
      ) : null}

      {loading && snapshot === null ? (
        <p className={styles.managerStatus}>{props.t('mcpConnectorsLoading')}</p>
      ) : error !== null && connectors.length === 0 ? (
        <div className={styles.managerEmptyBlock}>
          <p className={styles.managerFailure} role="alert">{error}</p>
        </div>
      ) : connectors.length === 0 ? (
        <div className={styles.managerEmptyBlock}>
          <p className={styles.managerEmpty}>{props.t('mcpConnectorsEmpty')}</p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setAddOpen(true)}
          >
            {props.t('mcpConnectorsAdd')}
          </Button>
        </div>
      ) : (
        <ul className={styles.managerCards}>
          {connectors.map(entry => (
            <li key={entry.id} className={styles.managerCard}>
              <div className={styles.managerCardHead}>
                <span className={styles.managerCardIcon} aria-hidden>
                  <IconLinkOutlineRegular size={22} />
                </span>
                <div className={styles.managerCardMain}>
                  <button
                    type="button"
                    className={styles.managerCardOpen}
                    onClick={() => {
                      setSelectedId(entry.id)
                      setConfirmId(null)
                    }}
                  >
                    <span className={styles.managerCardTitle}>{entry.serverName}</span>
                  </button>
                  <span className={styles.managerCardDesc}>{entrySubtitle(entry, props.t)}</span>
                  <span className={styles.managerCardDesc}>
                    {formatStatusLine(statusOf(snapshot, entry.id), props.t)}
                  </span>
                </div>
                <div className={styles.managerCardEnd}>
                  <Switch
                    checked={entry.enabled}
                    disabled={busy}
                    label={entry.enabled
                      ? props.t('mcpConnectorsEnabled')
                      : props.t('mcpConnectorsDisabled')}
                    onChange={next => {
                      void onToggle(entry, next)
                    }}
                  />
                  {confirmId === entry.id ? (
                    <div className={styles.managerConfirm}>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => { void onUninstall(entry) }}
                      >
                        {busy
                          ? props.t('mcpConnectorsUninstalling')
                          : props.t('mcpConnectorsUninstallConfirm')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setConfirmId(null)}
                      >
                        {props.t('mcpConnectorsUninstallCancel')}
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={styles.managerDeleteButton}
                      title={props.t('mcpConnectorsUninstallHint')}
                      aria-label={props.t('mcpConnectorsUninstall')}
                      disabled={busy}
                      onClick={() => setConfirmId(entry.id)}
                    >
                      <IconCloseOutlineRegular size={16} />
                    </button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ManagerAddSheet
        open={addOpen}
        title={props.t('mcpConnectorsAdd')}
        closeLabel={props.t('mcpConnectorsUninstallCancel')}
        onClose={() => setAddOpen(false)}
        footer={(
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setAddOpen(false)}
            >
              {props.t('mcpConnectorsUninstallCancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !canSubmitImport}
              onClick={() => { void onImportJson() }}
            >
              {busy ? props.t('mcpConnectorsImporting') : props.t('mcpConnectorsImport')}
            </Button>
          </>
        )}
      >
        <label className={styles.managerField}>
          <span className={styles.managerFieldLabel}>{props.t('mcpConnectorsJson')}</span>
          <textarea
            className={styles.managerTextarea}
            value={jsonText}
            onChange={event => setJsonText(event.target.value)}
            rows={14}
            spellCheck={false}
          />
        </label>
        <label className={styles.managerCheck}>
          <input
            type="checkbox"
            checked={force}
            onChange={event => setForce(event.target.checked)}
          />
          <span>{props.t('mcpConnectorsForceOverwrite')}</span>
        </label>
      </ManagerAddSheet>
    </ManagerPage>
  )
}
