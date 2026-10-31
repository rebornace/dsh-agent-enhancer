import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import type { ModuleName } from '../../config.ts'
import type { OverlapHintStore } from './plugin-hints.ts'
import styles from '../styles.module.css'

const HINT_KEYS = {
  history: 'overlapHistory',
  optimize: 'overlapOptimize',
  predict: 'overlapPredict',
} as const

export function CoexistenceHints({ store, t }: {
  readonly store: OverlapHintStore
  readonly t: TranslateNS<'composer-enhancer'>
}) {
  const hints = useSyncExternalStore(
    listener => store.subscribe(listener),
    () => store.getSnapshot(),
  )
  return <div className={styles.hints}>
    {hints.map(module => <div
      key={module}
      role="status"
      className={styles.hint}
      data-composer-enhancer-hint={module}
    >
      <span>{t(HINT_KEYS[module])}</span>
      <Button
        type="button"
        variant="toolbar"
        size="sm"
        aria-label={t('dismissHint')}
        title={t('dismissHint')}
        onClick={() => { store.dismiss(module) }}
      >×</Button>
    </div>)}
  </div>
}
