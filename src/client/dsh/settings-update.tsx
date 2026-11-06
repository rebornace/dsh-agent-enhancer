import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApplyUpdateResult, UpdateCheckResult } from '../../host/update/types.ts'
import styles from '../styles.module.css'

type UpdateUiState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'upToDate'; readonly result: UpdateCheckResult }
  | { readonly kind: 'available'; readonly result: UpdateCheckResult }
  | { readonly kind: 'applying'; readonly result: UpdateCheckResult }
  | { readonly kind: 'success'; readonly result: UpdateCheckResult }
  | {
    readonly kind: 'blocked'
    readonly result: UpdateCheckResult
    readonly reason: 'link' | 'manual'
  }
  | { readonly kind: 'checkError' }
  | {
    readonly kind: 'applyError'
    readonly result: UpdateCheckResult
    readonly command: string
  }

function resolveBlockedReason(result: UpdateCheckResult): 'link' | 'manual' {
  return result.installKind === 'link' ? 'link' : 'manual'
}

function resolveCheckState(result: UpdateCheckResult): UpdateUiState {
  if (result.latest === null) return { kind: 'checkError' }
  if (!result.updateAvailable) return { kind: 'upToDate', result }
  if (result.canAutoApply) return { kind: 'available', result }
  return { kind: 'blocked', result, reason: resolveBlockedReason(result) }
}

function resolveApplyState(
  result: UpdateCheckResult,
  apply: ApplyUpdateResult,
): UpdateUiState {
  const applyError: UpdateUiState = {
    kind: 'applyError',
    result,
    command: apply.command ?? result.command,
  }
  switch (apply.message) {
    case 'restart':
      return apply.ok ? { kind: 'success', result } : applyError
    case 'link':
      return { kind: 'blocked', result, reason: 'link' }
    case 'manual':
      return { kind: 'blocked', result, reason: 'manual' }
    case 'none':
      return resolveCheckState(result)
    case 'failed':
      return applyError
    default: {
      const unreachable: never = apply.message
      void unreachable
      return applyError
    }
  }
}

export interface SettingsUpdateSectionProps {
  readonly checkUpdate: () => Promise<UpdateCheckResult>
  readonly applyUpdate?: () => Promise<ApplyUpdateResult>
  readonly t: TranslateNS<'agent-enhancer'>
}

export function SettingsUpdateSection({ checkUpdate, applyUpdate, t }: SettingsUpdateSectionProps) {
  const [state, setState] = useState<UpdateUiState>({ kind: 'idle' })
  const [copied, setCopied] = useState(false)

  const runCheck = useCallback(async () => {
    setState({ kind: 'checking' })
    try {
      const result = await checkUpdate()
      setState(resolveCheckState(result))
    } catch {
      setState({ kind: 'checkError' })
    }
  }, [checkUpdate])

  useEffect(() => {
    void runCheck()
  }, [runCheck])

  const onApply = async () => {
    if (applyUpdate === undefined || state.kind !== 'available') return
    const result = state.result
    setState({ kind: 'applying', result })
    try {
      const apply = await applyUpdate()
      setState(resolveApplyState(result, apply))
    } catch {
      setState({ kind: 'applyError', result, command: result.command })
    }
  }

  const onCopy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 2000)
    } catch {
      setCopied(false)
    }
  }

  const checking = state.kind === 'checking'
  const applying = state.kind === 'applying'
  const busy = checking || applying
  const result = state.kind === 'idle' || state.kind === 'checkError'
    ? null
    : 'result' in state
      ? state.result
      : null

  let status: ReactNode = null
  switch (state.kind) {
    case 'idle':
      break
    case 'checking':
      status = <p className={styles.settingsUpdateStatus} role="status">{t('updateChecking')}</p>
      break
    case 'upToDate':
      status = <p className={styles.settingsUpdateStatus} role="status">{t('updateLatest')}</p>
      break
    case 'available':
      status = <p className={styles.settingsUpdateStatus} role="status">
        {t('updateAvailable', { version: state.result.latest ?? state.result.current })}
      </p>
      break
    case 'applying':
      status = <p className={styles.settingsUpdateStatus} role="status">{t('updateApplying')}</p>
      break
    case 'success':
      status = <p className={styles.settingsUpdateStatus} role="status">{t('updateRestart')}</p>
      break
    case 'blocked':
      status = <p className={styles.settingsUpdateStatus} role="status">
        {state.reason === 'link' ? t('updateLinkBlocked') : t('updateManual')}
      </p>
      break
    case 'checkError':
      status = <p className={styles.settingsUpdateStatus} role="status">{t('updateCheckFailed')}</p>
      break
    case 'applyError':
      status = <p className={styles.settingsUpdateStatus} role="status">{t('updateFailed')}</p>
      break
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }

  return <div className={styles.settingsUpdate} aria-label={t('updateTitle')}>
    <div className={styles.settingRow}>
      <div className={styles.settingText}>
        <div className={styles.settingTitle}>{t('updateTitle')}</div>
        {result !== null && (
          <p className={styles.settingDescription}>
            {t('updateCurrent', { version: result.current })}
          </p>
        )}
      </div>
      <div className={styles.settingControls}>
        {state.kind === 'available' && applyUpdate !== undefined && (
          <button
            type="button"
            className={styles.settingsActionPrimary}
            disabled={busy}
            onClick={() => { void onApply() }}
          >
            {t('updateApply', { version: state.result.latest ?? state.result.current })}
          </button>
        )}
        <button
          type="button"
          className={styles.settingsActionPrimary}
          disabled={busy}
          onClick={() => { void runCheck() }}
        >
          {checking ? t('updateChecking') : t('updateCheck')}
        </button>
      </div>
    </div>
    {status}
    {state.kind === 'blocked' && (
      <>
        <pre className={styles.updateCommand}>{state.result.command}</pre>
        <button
          type="button"
          className={styles.settingsConfigure}
          onClick={() => { void onCopy(state.result.command) }}
        >
          {copied ? t('updateCopied') : t('updateCopy')}
        </button>
      </>
    )}
    {state.kind === 'applyError' && (
      <>
        <pre className={styles.updateCommand}>{state.command}</pre>
        <button
          type="button"
          className={styles.settingsConfigure}
          onClick={() => { void onCopy(state.command) }}
        >
          {copied ? t('updateCopied') : t('updateCopy')}
        </button>
      </>
    )}
  </div>
}
