import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderBalanceSnapshot, ProviderBalanceSource } from '../../host/usage/types.ts'
import styles from '../styles.module.css'

export interface ProviderBalanceChipProps {
  readonly source: ProviderBalanceSource
  readonly t: TranslateNS<'agent-enhancer'>
  readonly load: (force?: boolean) => Promise<ProviderBalanceSnapshot>
}

type ChipState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready', readonly snapshot: ProviderBalanceSnapshot }
  | { readonly kind: 'error' }

export function ProviderBalanceChip(props: ProviderBalanceChipProps) {
  const { source, t, load } = props
  const [state, setState] = useState<ChipState>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (force: boolean) => {
    setBusy(true)
    try {
      const snapshot = await load(force)
      setState({ kind: 'ready', snapshot })
    } catch {
      setState({ kind: 'error' })
    } finally {
      setBusy(false)
    }
  }, [load])

  useEffect(() => {
    void refresh(false)
  }, [refresh])

  let primary = t('providerBalanceLoading')
  let detail: string | undefined
  if (state.kind === 'error') {
    primary = t('providerBalanceUnavailable')
  } else if (state.kind === 'ready') {
    const snapshot = state.snapshot
    if (snapshot.balance !== undefined) {
      primary = t('providerBalanceLabel', { amount: snapshot.balance.total })
      if (source === 'account') {
        detail = t('providerBalanceDetail', {
          granted: snapshot.balance.granted,
          toppedUp: snapshot.balance.toppedUp,
        })
      }
      if (snapshot.balance.stale === true) {
        detail = detail === undefined
          ? t('providerBalanceStale')
          : `${detail} · ${t('providerBalanceStale')}`
      }
    } else {
      switch (snapshot.status) {
        case 'no-key':
          primary = t('providerBalanceNoKey')
          break
        case 'signed-out':
          primary = t('providerBalanceSignedOut')
          break
        case 'unavailable':
        case 'ready':
          primary = t('providerBalanceUnavailable')
          break
        default: {
          const _exhaustive: never = snapshot.status
          primary = _exhaustive
        }
      }
    }
  }

  return (
    <button
      type="button"
      className={styles.providerBalanceChip}
      data-provider-balance={source}
      aria-busy={busy}
      title={t('providerBalanceRefreshHint')}
      onClick={() => { void refresh(true) }}
    >
      <span className={styles.providerBalancePrimary}>{primary}</span>
      {detail !== undefined && (
        <span className={styles.providerBalanceDetail}>{detail}</span>
      )}
    </button>
  )
}
